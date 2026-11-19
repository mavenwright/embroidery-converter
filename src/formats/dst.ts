// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of DstReader.py and DstWriter.py (pystitch 1.0.1). Units are 0.1 mm.
//
// pystitch -> TS: getbit/decode_dx/decode_dy -> getbit/decodeDx/decodeDy; process_header_info -> processHeaderInfo;
// dst_read_header -> readHeader; dst_read_stitches -> readStitches; read -> readDst; bit/encode_record ->
// bit/encodeRecord; write (+ write_embroidery's merge and normalize) -> writeDst.
import {
  COLOR_CHANGE,
  COMMAND_MASK,
  END,
  JUMP,
  SEQUIN_EJECT,
  SEQUIN_MODE,
  STITCH,
  STOP,
  TRIM,
} from "../core/constants";
import { normalize } from "../core/encoder";
import { EmbPattern } from "../core/pattern";
import {
  INKSTITCH_EXPORT_SETTINGS,
  effectiveSettings,
  pyTruthy,
  settingsGet,
  shouldEncode,
  type WriterSettings,
} from "../core/settings";
import { pyRound } from "../core/thread";
import { ByteReader, pyStrip } from "../io/reader";
import { ByteWriter } from "../io/writer";

const DST_HEADER_SIZE = 512; // DSTHEADERSIZE

// ---------------------------------------------------------------------------------------------------- reader

function getbit(b: number, pos: number): number {
  return (b >> pos) & 1;
}

export function decodeDx(b0: number, b1: number, b2: number): number {
  let x = 0;
  x += getbit(b2, 2) * +81;
  x += getbit(b2, 3) * -81;
  x += getbit(b1, 2) * +27;
  x += getbit(b1, 3) * -27;
  x += getbit(b0, 2) * +9;
  x += getbit(b0, 3) * -9;
  x += getbit(b1, 0) * +3;
  x += getbit(b1, 1) * -3;
  x += getbit(b0, 0) * +1;
  x += getbit(b0, 1) * -1;
  return x;
}

export function decodeDy(b0: number, b1: number, b2: number): number {
  let y = 0;
  y += getbit(b2, 5) * +81;
  y += getbit(b2, 4) * -81;
  y += getbit(b1, 5) * +27;
  y += getbit(b1, 4) * -27;
  y += getbit(b0, 5) * +9;
  y += getbit(b0, 4) * -9;
  y += getbit(b1, 7) * +3;
  y += getbit(b1, 6) * -3;
  y += getbit(b0, 7) * +1;
  y += getbit(b0, 6) * -1;
  return 0 - y; // 0 - y, not -y: Python's -0 is 0, JS's is -0.
}

function processHeaderInfo(out: EmbPattern, prefix: string, value: string): void {
  if (prefix === "LA") {
    out.metadata("name", value);
  } else if (prefix === "AU") {
    out.metadata("author", value);
  } else if (prefix === "CP") {
    out.metadata("copyright", value);
  } else if (prefix === "TC") {
    const values = value.split(",").map(pyStrip);
    // Python indexes values[1] and values[2] and raises IndexError on a short TC line; so do we.
    if (values.length < 3) throw new RangeError("list index out of range");
    out.addThread({ hex: values[0], description: values[1], catalog: values[2] });
  } else {
    out.metadata(prefix, value);
  }
}

/** The reader settings DstReader.read looks at (all optional; pystitch.read passes none by default). */
export interface DstReadSettings {
  trim_at?: number | null;
  /** In mm. */
  trim_distance?: number | null;
  clipping?: boolean | null;
  /** API safety limit (not in pystitch): stop with StitchLimitError beyond this many stitches. */
  maxStitches?: number | null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function readHeader(f: ByteReader, out: EmbPattern): void {
  const header = f.read(DST_HEADER_SIZE);
  let start = 0;
  for (let i = 0; i < header.length; i++) {
    const element = header[i];
    if (element === 13 || element === 10) {
      // 13 == '\r', 10 == '\n'
      const end = i;
      const data = header.subarray(start, end);
      start = end;
      let text: string;
      try {
        text = pyStrip(utf8.decode(data));
      } catch {
        continue; // Non-utf8 information. See #83
      }
      const line = Array.from(text); // Python indexes code points.
      if (line.length > 3) {
        processHeaderInfo(out, pyStrip(line.slice(0, 2).join("")), pyStrip(line.slice(3).join("")));
      }
    }
  }
}

function readStitches(f: ByteReader, out: EmbPattern, settings: DstReadSettings | null): void {
  let sequinMode = false;
  for (;;) {
    const byte = f.read(3);
    if (byte.length !== 3) break;
    const dx = decodeDx(byte[0], byte[1], byte[2]);
    const dy = decodeDy(byte[0], byte[1], byte[2]);
    if ((byte[2] & 0b11110011) === 0b11110011) {
      break;
    } else if ((byte[2] & 0b11000011) === 0b11000011) {
      out.colorChange(dx, dy);
    } else if ((byte[2] & 0b01000011) === 0b01000011) {
      out.sequinMode(dx, dy);
      sequinMode = !sequinMode;
    } else if ((byte[2] & 0b10000011) === 0b10000011) {
      if (sequinMode) out.sequinEject(dx, dy);
      else out.move(dx, dy);
    } else {
      out.stitch(dx, dy);
    }
  }
  out.end();

  let countMax: number | null = 3;
  let clipping = true;
  let trimDistance: number | null = null;
  if (settings !== null) {
    if (settings.trim_at !== undefined) countMax = settings.trim_at;
    if (settings.trim_distance !== undefined) trimDistance = settings.trim_distance;
    if (settings.clipping !== undefined) clipping = pyTruthy(settings.clipping);
  }
  if (trimDistance !== null) trimDistance *= 10; // Pixels per mm. Native units are 1/10 mm.
  out.interpolateTrims(countMax, trimDistance, clipping);
}

/** DstReader.read: header (LA name, AU, CP, TC threads, any other field into extras) then stitches. */
export function readDst(bytes: Uint8Array | ArrayBuffer, settings: DstReadSettings | null = null): EmbPattern {
  const f = new ByteReader(bytes);
  const out = new EmbPattern();
  out.maxStitches = settings?.maxStitches ?? null;
  readHeader(f, out);
  readStitches(f, out, settings);
  return out;
}

// ---------------------------------------------------------------------------------------------------- writer

const bit = (b: number): number => 1 << b;

export function encodeRecord(x: number, y: number, flags: number): Uint8Array {
  y = 0 - y; // flips the coordinate y space.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  if (flags === JUMP || flags === SEQUIN_EJECT) b2 += bit(7); // jumpstitch 10xxxx11
  if (flags === STITCH || flags === JUMP || flags === SEQUIN_EJECT) {
    b2 += bit(0);
    b2 += bit(1);
    if (x > 40) {
      b2 += bit(2);
      x -= 81;
    }
    if (x < -40) {
      b2 += bit(3);
      x += 81;
    }
    if (x > 13) {
      b1 += bit(2);
      x -= 27;
    }
    if (x < -13) {
      b1 += bit(3);
      x += 27;
    }
    if (x > 4) {
      b0 += bit(2);
      x -= 9;
    }
    if (x < -4) {
      b0 += bit(3);
      x += 9;
    }
    if (x > 1) {
      b1 += bit(0);
      x -= 3;
    }
    if (x < -1) {
      b1 += bit(1);
      x += 3;
    }
    if (x > 0) {
      b0 += bit(0);
      x -= 1;
    }
    if (x < 0) {
      b0 += bit(1);
      x += 1;
    }
    if (x !== 0) throw new RangeError("The dx value given to the writer exceeds maximum allowed.");
    if (y > 40) {
      b2 += bit(5);
      y -= 81;
    }
    if (y < -40) {
      b2 += bit(4);
      y += 81;
    }
    if (y > 13) {
      b1 += bit(5);
      y -= 27;
    }
    if (y < -13) {
      b1 += bit(4);
      y += 27;
    }
    if (y > 4) {
      b0 += bit(5);
      y -= 9;
    }
    if (y < -4) {
      b0 += bit(4);
      y += 9;
    }
    if (y > 1) {
      b1 += bit(7);
      y -= 3;
    }
    if (y < -1) {
      b1 += bit(6);
      y += 3;
    }
    if (y > 0) {
      b0 += bit(7);
      y -= 1;
    }
    if (y < 0) {
      b0 += bit(6);
      y += 1;
    }
    if (y !== 0) throw new RangeError("The dy value given to the writer exceeds maximum allowed.");
  } else if (flags === COLOR_CHANGE) {
    b2 = 0b11000011;
  } else if (flags === STOP) {
    b2 = 0b11000011;
  } else if (flags === END) {
    b2 = 0b11110011;
  } else if (flags === SEQUIN_MODE) {
    b2 = 0b01000011;
  }
  // Any other command writes the all-zero record, as pystitch does.
  return Uint8Array.of(b0, b1, b2);
}

/** Python's "%Nd" for an integer-valued number: truncates, right-aligns in `width`. Inf/NaN raise, as in Python. */
function fmtInt(value: number, width: number): string {
  if (!Number.isFinite(value)) throw new RangeError("cannot convert float infinity or NaN to integer (empty pattern?)");
  return String(Math.trunc(value)).padStart(width, " ");
}

/** Python's "%s" of a value (None prints as "None"). */
const fmtStr = (v: unknown): string => (v === null || v === undefined ? "None" : String(v));

/** The ported DstWriter.write: writes `pattern` as is (no normalizing). */
function writeRaw(pattern: EmbPattern, f: ByteWriter, settings: WriterSettings): void {
  let extendedHeader = pyTruthy(settingsGet(settings, "extended header", false)); // deprecated
  const version = settingsGet(settings, "version", "default");
  if (version === "extended") extendedHeader = true;
  const trimAt = settingsGet(settings, "trim_at", 3);
  if (typeof trimAt !== "number") throw new TypeError("trim_at must be a number");
  const bounds = pattern.bounds();

  const name = fmtStr(pattern.getMetadata("name", "Untitled"));
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - Array.from(s).length));

  f.stringUtf8(`LA:${pad(name, 16)}\r`);
  f.stringUtf8(`ST:${fmtInt(pattern.countStitches(), 7)}\r`);
  f.stringUtf8(`CO:${fmtInt(pattern.countColorChanges() + pattern.countStitchCommands(STOP), 3)}\r`);
  f.stringUtf8(`+X:${fmtInt(Math.abs(bounds[2]), 5)}\r`);
  f.stringUtf8(`-X:${fmtInt(Math.abs(bounds[0]), 5)}\r`);
  f.stringUtf8(`+Y:${fmtInt(Math.abs(bounds[3]), 5)}\r`);
  f.stringUtf8(`-Y:${fmtInt(Math.abs(bounds[1]), 5)}\r`);
  let ax = 0;
  let ay = 0;
  if (pattern.stitches.length > 0) {
    const last = pattern.stitches.length - 1;
    ax = Math.trunc(pattern.stitches[last][0]);
    ay = 0 - Math.trunc(pattern.stitches[last][1]);
  }
  if (ax >= 0) f.stringUtf8(`AX:+${fmtInt(ax, 5)}\r`);
  else f.stringUtf8(`AX:-${fmtInt(Math.abs(ax), 5)}\r`);
  if (ay >= 0) f.stringUtf8(`AY:+${fmtInt(ay, 5)}\r`);
  else f.stringUtf8(`AY:-${fmtInt(Math.abs(ay), 5)}\r`);
  f.stringUtf8(`MX:+${fmtInt(0, 5)}\r`);
  f.stringUtf8(`MY:+${fmtInt(0, 5)}\r`);
  f.stringUtf8(`PD:${"******".padStart(6, " ")}\r`);
  if (extendedHeader) {
    const author = pattern.getMetadata("author");
    if (author !== null) f.stringUtf8(`AU:${fmtStr(author)}\r`);
    const metaCopyright = pattern.getMetadata("copyright");
    if (metaCopyright !== null) f.stringUtf8(`CP:${fmtStr(metaCopyright)}\r`);
    for (const thread of pattern.threads) {
      f.stringUtf8(`TC:${thread.hexColor()},${fmtStr(thread.description)},${fmtStr(thread.catalogNumber)}\r`);
    }
  }
  f.write(Uint8Array.of(0x1a));
  for (let i = f.tell(); i < DST_HEADER_SIZE; i++) f.write(Uint8Array.of(0x20)); // space

  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const x = stitch[0];
    const y = stitch[1];
    const data = stitch[2] & COMMAND_MASK;
    const dx = pyRound(x - xx);
    const dy = pyRound(y - yy);

    xx += dx;
    yy += dy;
    if (data === TRIM) {
      let delta = -4;
      f.write(encodeRecord(-delta / 2, -delta / 2, JUMP));
      for (let p = 1; p < trimAt - 1; p++) {
        f.write(encodeRecord(delta, delta, JUMP));
        delta = -delta;
      }
      f.write(encodeRecord(delta / 2, delta / 2, JUMP));
    } else {
      f.write(encodeRecord(dx, dy, data));
    }
  }
}

/**
 * write_embroidery for DST: merge `settings` with DstWriter's constants, normalize through the encoder when encode
 * is on, then write. The source pattern is not modified.
 */
export function writeDst(pattern: EmbPattern, settings: WriterSettings = INKSTITCH_EXPORT_SETTINGS): Uint8Array {
  const merged = effectiveSettings("dst", settings);
  const source = shouldEncode("dst", merged) ? normalize(pattern, merged) : pattern;
  const out = new ByteWriter(4096);
  writeRaw(source, out, merged);
  return out.toUint8Array();
}
