// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of JefReader.py and JefWriter.py (pystitch 1.0.1). Units are 0.1 mm.
//
// pystitch -> TS: read_jef_stitches -> readStitches; read -> readJef; write (+ write_embroidery's merge and
// normalize) -> writeJef (raw writer: writeRaw); get_jef_hoop_size -> getJefHoopSize;
// write_hoop_edge_distance -> writeHoopEdgeDistance.
import { COLOR_CHANGE, COMMAND_MASK, END, JUMP, STITCH, STOP, TRIM } from "../core/constants";
import { normalize } from "../core/encoder";
import { EmbPattern } from "../core/pattern";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings, pyTruthy, settingsGet, shouldEncode, type WriterSettings } from "../core/settings";
import { EmbThread, PlaceholderThread, pyRound } from "../core/thread";
import { getThreadSet } from "../threads/jef";
import { ByteReader, signed8 } from "../io/reader";
import { ByteWriter } from "../io/writer";

// These are in mm in pystitch's comment, embroidery units are 1/10 mm.
export const HOOP_110X110 = 0;
export const HOOP_50X50 = 1;
export const HOOP_140X200 = 2;
export const HOOP_126X110 = 3;
export const HOOP_200X200 = 4;

/** The reader settings JefReader looks at (all optional; pystitch.read passes none by default). */
export interface JefReadSettings {
  trims?: boolean | null;
  trim_at?: number | null;
  /** In mm. Default 3.0 for JEF. */
  trim_distance?: number | null;
  clipping?: boolean | null;
  /** API safety limit (not in pystitch): stop with StitchLimitError beyond this many stitches. */
  maxStitches?: number | null;
}

function need(v: number | null, what: string): number {
  if (v === null) throw new Error(`Can't read this JEF file: truncated ${what}.`);
  return v;
}

/** JefReader.read_jef_stitches. */
function readStitches(f: ByteReader, out: EmbPattern, settings: JefReadSettings | null): void {
  // Python's threadlist holds None for "colour 0" (stop) entries; the TS list is typed EmbThread[].
  const threads = out.threads as Array<EmbThread | null>;
  let colorIndex = 1;
  for (;;) {
    let b = f.read(2);
    if (b.length !== 2) break;
    if (b[0] !== 0x80) {
      out.stitch(signed8(b[0]), 0 - signed8(b[1]));
      continue;
    }
    const ctrl = b[1];
    b = f.read(2);
    if (b.length !== 2) break;
    const x = signed8(b[0]);
    const y = 0 - signed8(b[1]);
    if (ctrl === 0x02) {
      if (x === 0 && y === 0) {
        // A single zero-length jump is read as a trim (see JefReader.py).
        out.trim(x, y);
      } else {
        out.move(x, y);
      }
      continue;
    }
    if (ctrl === 0x01) {
      // PATCH: None means stop since it was color #0
      if (colorIndex >= threads.length) {
        // pystitch raises IndexError here.
        throw new Error("Can't read this JEF file: more colour changes than threads.");
      }
      if (threads[colorIndex] === null) {
        out.stop(0, 0);
        threads.splice(colorIndex, 1);
      } else {
        out.colorChange(0, 0);
        colorIndex += 1;
      }
      continue;
    }
    break; // 0x10 is the end record; anything else is an uncaught control.
  }
  out.end(0, 0);

  let clipping = true;
  let trims = false;
  let countMax: number | null = null;
  let trimDistance: number | null = 3.0;
  if (settings !== null) {
    // dict.get(key, default): an absent (or undefined) key means the default; null is Python's None.
    if (settings.trim_at !== undefined) countMax = settings.trim_at;
    if (settings.trims !== undefined) trims = pyTruthy(settings.trims);
    if (settings.trim_distance !== undefined) trimDistance = settings.trim_distance;
    if (settings.clipping !== undefined) clipping = pyTruthy(settings.clipping);
  }
  if (trims && countMax === null) countMax = 3;
  if (trimDistance !== null) trimDistance *= 10; // Pixels per mm. Native units are 1/10 mm.
  out.interpolateTrims(countMax, trimDistance, clipping);
}

/**
 * JefReader.read: header, thread palette, then stitches. Throws an Error when the header or palette is truncated
 * (pystitch raises TypeError there). A colour-0 palette entry is pystitch's None: a colour change that reaches it
 * becomes a stop and removes it, as in pystitch. One that no colour change reaches (normally the first entry) stays
 * where pystitch keeps its None, as a PlaceholderThread, so colour block n still uses thread n. The parity dumps show
 * it as null; writers, stats and the preview use the deterministic filler colour for that index (pystitch's own
 * writers crash on the None).
 */
export function readJef(bytes: Uint8Array | ArrayBuffer, settings: JefReadSettings | null = null): EmbPattern {
  const f = new ByteReader(bytes);
  const out = new EmbPattern();
  out.maxStitches = settings?.maxStitches ?? null;
  const jefThreads = getThreadSet();
  const stitchOffset = need(f.int32le(), "header");
  f.seek(20, 1);
  const countColors = need(f.int32le(), "header");
  f.seek(88, 1);

  const threads = out.threads as Array<EmbThread | null>;
  for (let i = 0; i < countColors; i++) {
    const index = need(f.int32le(), "thread list"); // read_int_32le is unsigned: abs() is a no-op.
    if (index === 0) {
      // Patch: If we have color 0. Go ahead and set that to None.
      threads.push(null);
    } else {
      const thread = jefThreads[index % jefThreads.length];
      // pystitch's add_thread(None) appends a default EmbThread (black); the palette's slot 0 is None.
      threads.push(thread ?? new EmbThread());
    }
  }

  f.seek(stitchOffset, 0);
  readStitches(f, out, settings);
  out.threads = threads.map((t, i) => t ?? new PlaceholderThread(i));
  return out;
}

/** JefWriter.get_jef_hoop_size. */
export function getJefHoopSize(width: number, height: number): number {
  if (width < 500 && height < 500) return HOOP_50X50;
  if (width < 1260 && height < 1100) return HOOP_126X110;
  if (width < 1400 && height < 2000) return HOOP_140X200;
  if (width < 2000 && height < 2000) return HOOP_200X200;
  return HOOP_110X110;
}

/** JefWriter.write_hoop_edge_distance. */
function writeHoopEdgeDistance(f: ByteWriter, xHoopEdge: number, yHoopEdge: number): void {
  if (Math.min(xHoopEdge, yHoopEdge) >= 0) {
    f.int32le(xHoopEdge); // left
    f.int32le(yHoopEdge); // top
    f.int32le(xHoopEdge); // right
    f.int32le(yHoopEdge); // bottom
  } else {
    f.int32le(-1);
    f.int32le(-1);
    f.int32le(-1);
    f.int32le(-1);
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** datetime.datetime.today().strftime("%Y%m%d%H%M%S") (local time). */
function todayStamp(): string {
  const d = new Date();
  return `${String(d.getFullYear()).padStart(4, "0")}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** The ported JefWriter.write: writes `pattern` as is (no normalizing), except for fix_color_count, which mutates it. */
function writeRaw(pattern: EmbPattern, f: ByteWriter, settings: WriterSettings): void {
  const trims = pyTruthy(settingsGet(settings, "trims", false));
  const trimAt = settingsGet(settings, "trim_at", 3);
  const dateString = settingsGet(settings, "date", todayStamp());
  if (dateString === null) throw new TypeError("date must be a string");
  const commandCountMax = (): number => {
    if (trimAt === null) throw new TypeError("trim_at must be a number when writing trims");
    return trimAt;
  };

  pattern.fixColorCount();

  // PATCH
  const jefThreads = getThreadSet();
  let lastIndex: number | null = null;
  let lastThread: EmbThread | null = null;
  const palette: number[] = [];
  let colorToggled = false;
  let colorCount = 0; // Color and Stop count.
  let indexInThreadlist = 0;
  for (const stitch of pattern.stitches) {
    const flags = stitch[2] & COMMAND_MASK;
    if (flags === COLOR_CHANGE || indexInThreadlist === 0) {
      // If color change *or* initial color unset.
      const thread = pattern.threads[indexInThreadlist];
      if (thread === undefined) throw new RangeError("not enough threads for the colour changes");
      indexInThreadlist += 1;
      colorCount += 1;
      let indexOfJefThread = thread.findNearestColorIndex(jefThreads) as number;
      if (lastIndex === indexOfJefThread && (lastThread === null || !lastThread.equals(thread))) {
        // Last thread and current thread pigeonhole to same jefcolor.
        // We set that thread to None. And get the second closest color.
        const repeatedThread = jefThreads[indexOfJefThread];
        const repeatedIndex = indexOfJefThread;
        jefThreads[indexOfJefThread] = null;
        indexOfJefThread = thread.findNearestColorIndex(jefThreads) as number;
        jefThreads[repeatedIndex] = repeatedThread;
      }
      palette.push(indexOfJefThread);
      lastIndex = indexOfJefThread;
      lastThread = thread;
      colorToggled = false;
    }
    if (flags === STOP) {
      colorCount += 1;
      colorToggled = !colorToggled;
      palette.push(colorToggled ? 0 : (lastIndex as number));
    }
  }
  // END PATCH

  const offsets = 0x74 + colorCount * 8;
  f.int32le(offsets);
  f.int32le(0x14);
  f.stringUtf8(dateString);
  f.int8(0);
  f.int8(0);
  f.int32le(colorCount);
  let pointCount = 1; // 1 command for END statement
  for (const stitch of pattern.stitches) {
    const data = stitch[2] & COMMAND_MASK;
    if (data === STITCH) {
      pointCount += 1;
    } else if (data === JUMP) {
      pointCount += 2;
    } else if (data === TRIM) {
      if (trims) pointCount += 2 * commandCountMax();
    } else if (data === COLOR_CHANGE || data === STOP) {
      pointCount += 2; // PATCH: INCLUDE STOP.
    } else if (data === END) {
      break;
    }
  }
  f.int32le(pointCount);
  const extends_ = pattern.bounds();
  const widthRaw = extends_[2] - extends_[0];
  const heightRaw = extends_[3] - extends_[1];
  if (!Number.isFinite(widthRaw) || !Number.isFinite(heightRaw)) {
    throw new RangeError("cannot write an empty pattern as JEF"); // pystitch: OverflowError on int(round(inf)).
  }
  const designWidth = pyRound(widthRaw);
  const designHeight = pyRound(heightRaw);
  f.int32le(getJefHoopSize(designWidth, designHeight));
  const halfWidth = pyRound(designWidth / 2);
  const halfHeight = pyRound(designHeight / 2);

  // distance from center of hoop.
  f.int32le(halfWidth);
  f.int32le(halfHeight);
  f.int32le(halfWidth);
  f.int32le(halfHeight);

  writeHoopEdgeDistance(f, 550 - halfWidth, 550 - halfHeight); // default 110 x 110 hoop
  writeHoopEdgeDistance(f, 250 - halfWidth, 250 - halfHeight); // default 50 x 50 hoop
  writeHoopEdgeDistance(f, 700 - halfWidth, 1000 - halfHeight); // default 140 x 200 hoop
  writeHoopEdgeDistance(f, 700 - halfWidth, 1000 - halfHeight); // custom hoop, but this should be accepted.

  for (const t of palette) f.int32le(t);
  for (let i = 0; i < colorCount; i++) f.int32le(0x0d);

  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const data = stitch[2] & COMMAND_MASK;
    const dx = pyRound(stitch[0] - xx);
    const dy = pyRound(stitch[1] - yy);
    xx += dx;
    yy += dy;
    if (data === STITCH) {
      f.int8(dx);
      f.int8(-dy);
    } else if (data === COLOR_CHANGE || data === STOP) {
      f.write(Uint8Array.of(0x80, 0x01)); // PATCH INCLUDE STOP.
      f.int8(dx);
      f.int8(-dy);
    } else if (data === TRIM) {
      if (trims) {
        // command trim.
        for (let i = commandCountMax(); i > 0; i--) f.write(Uint8Array.of(0x80, 0x02, 0x00, 0x00));
      }
    } else if (data === JUMP) {
      f.write(Uint8Array.of(0x80, 0x02));
      f.int8(dx);
      f.int8(-dy);
    } else if (data === END) {
      break;
    }
  }
  f.write(Uint8Array.of(0x80, 0x10));
}

/**
 * write_embroidery for JEF: merge `settings` with JefWriter's constants, normalize through the encoder when encode
 * is on, then write. The source pattern is not modified when encoding (pystitch writes a normalized copy).
 * `settings.date` is the "%Y%m%d%H%M%S" stamp; it defaults to the current local time, as in pystitch.
 */
export function writeJef(pattern: EmbPattern, settings: WriterSettings = INKSTITCH_EXPORT_SETTINGS): Uint8Array {
  const merged = effectiveSettings("jef", settings);
  const source = shouldEncode("jef", merged) ? normalize(pattern, merged) : pattern;
  const out = new ByteWriter(4096);
  writeRaw(source, out, merged);
  return out.toUint8Array();
}
