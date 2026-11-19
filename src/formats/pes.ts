// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of PesReader.py and PesWriter.py (pystitch 1.0.1): Brother/Babylock PES. Units are 0.1 mm.
//
// pystitch -> TS (reader): read -> readPes, with the per-version headers in ./pesHeader (split for size).
// pystitch -> TS (writer): write (+ write_embroidery's merge and normalize) -> writePes (raw writer: writeRaw);
// write_truncated_version_1/6, write_version_1/6, write_pes_header_v1/v6, write_pes_addendum, write_pes_string_8/16,
// write_pes_thread, write_pes_blocks, write_pes_sewsegheader, get_as_segments_blocks,
// write_pes_embsewseg_segments -> the camelCase functions below. The PEC block is in ./pec.
import { COLOR_CHANGE, COMMAND_MASK, JUMP, STITCH } from "../core/constants";
import { normalize } from "../core/encoder";
import { EmbPattern } from "../core/pattern";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings, pyTruthy, settingsGet, shouldEncode, type WriterSettings } from "../core/settings";
import type { ReadLimitOptions } from "./exp";
import { EmbThread, type Palette } from "../core/thread";
import { getThreadSet } from "../threads/pec";
import { ByteReader, pyStrip } from "../io/reader";
import { ByteWriter } from "../io/writer";
import { readPecBody, writePec, type PecColorInfo } from "./pec";
import { METADATA_KEYS, readPesHeader } from "./pesHeader";

// ------------------------------------------------------------------------------------------------ PesReader

/**
 * PesReader.read: the PES header (version, then the metadata and thread table that versions 4 to 10 carry; see
 * ./pesHeader), then the PEC block it points to. A "#PEC0001" file is read as a bare PEC block. Throws an Error where
 * pystitch raises (input too short for the PEC offset, a truncated thread table or PEC header).
 */
export function readPes(bytes: Uint8Array | ArrayBuffer, opts: ReadLimitOptions | null = {}): EmbPattern {
  const f = new ByteReader(bytes);
  const out = new EmbPattern();
  out.maxStitches = opts?.maxStitches ?? null;
  const loadedThreadValues: EmbThread[] = [];
  const pesString = f.string(8);

  if (pesString === "#PEC0001") {
    readPecBody(f, out, loadedThreadValues);
    out.interpolateDuplicateColorAsStop();
    return out;
  }

  const pecBlockPosition = f.int32le();
  readPesHeader(pesString, f, out, loadedThreadValues);
  if (pecBlockPosition === null) throw new Error("Can't read this PES file: truncated header."); // seek(None) raises
  f.seek(pecBlockPosition, 0);
  readPecBody(f, out, loadedThreadValues);
  out.interpolateDuplicateColorAsStop();
  return out;
}

// ------------------------------------------------------------------------------------------------ PesWriter

export const VERSION_1 = 1.0;
export const VERSION_6 = 6.0;

export const PES_VERSION_1_SIGNATURE = "#PES0001";
export const PES_VERSION_6_SIGNATURE = "#PES0060";

export const EMB_ONE = "CEmbOne";
export const EMB_SEG = "CSewSeg";

const DECIMAL = String.raw`\d(?:_?\d)*`;
const PY_FLOAT = new RegExp(`^[+-]?(?:${DECIMAL}(?:\\.(?:${DECIMAL})?)?|\\.${DECIMAL})(?:[eE][+-]?${DECIMAL})?$`);
const PY_SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;

/** Python's float(value) for the values a settings dict can carry (ASCII digits only). */
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const s = pyStrip(value);
    if (PY_FLOAT.test(s)) return Number(s.replace(/_/g, ""));
    const special = PY_SPECIAL.exec(s);
    if (special !== null) {
      if (special[2].toLowerCase() === "nan") return NaN;
      return special[1] === "-" ? -Infinity : Infinity;
    }
    throw new Error(`could not convert string to float: '${value}'`); // ValueError
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${value === null ? "NoneType" : typeof value}'`);
}

/**
 * The ported PesWriter.write: writes `pattern` as is (no normalizing), except that it fixes the colour count and turns
 * stops into duplicate colours, which mutates it (as in pystitch). A version other than 1 or 6 writes nothing.
 */
function writeRaw(pattern: EmbPattern, f: ByteWriter, settings: WriterSettings | null): void {
  pattern.fixColorCount();
  pattern.interpolateStopAsDuplicateColor();
  let version: unknown = VERSION_1;
  let truncated: unknown = false;
  if (settings !== null) {
    version = settingsGet(settings, "pes version", VERSION_1); // deprecated, use "version".
    version = settingsGet(settings, "version", version);
    truncated = settingsGet(settings, "truncated", false);
    if (typeof version === "string") {
      if (version.endsWith("t")) {
        truncated = true;
        version = pyFloat(version.slice(0, -1));
      }
    }
    version = pyFloat(version);
  }
  if (pyTruthy(truncated)) {
    if (version === VERSION_1) writeTruncatedVersion1(pattern, f);
    else if (version === VERSION_6) writeTruncatedVersion6(pattern, f);
  } else {
    if (version === VERSION_1) writeVersion1(pattern, f);
    else if (version === VERSION_6) writeVersion6(pattern, f);
  }
}

function writeTruncatedVersion1(pattern: EmbPattern, f: ByteWriter): void {
  f.stringUtf8(PES_VERSION_1_SIGNATURE);
  f.write(Uint8Array.of(0x16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  writePec(pattern, f);
}

function writeTruncatedVersion6(pattern: EmbPattern, f: ByteWriter): void {
  const chart = pattern.threads;
  f.stringUtf8(PES_VERSION_6_SIGNATURE);
  const placeholderPecBlock = f.tell();
  f.int32le(0); // Placeholder for PEC BLOCK
  writePesHeaderV6(pattern, f, chart, 0);
  f.write(new Uint8Array(5));
  f.int16le(0x0000);
  f.int16le(0x0000);
  const currentPosition = f.tell();
  f.seek(placeholderPecBlock, 0);
  f.int32le(currentPosition);
  f.seek(currentPosition, 0);
  writePec(pattern, f);
  writePesAddendum(f, [[0xff], []]);
  f.int16le(0x0000); // Found in version 6 not 5,4
}

/** The design bounds relative to its centre, as write_version_1/6 compute them. */
function centredBounds(pattern: EmbPattern): { left: number; top: number; right: number; bottom: number; cx: number; cy: number } {
  const extends_ = pattern.bounds();
  const cx = (extends_[2] + extends_[0]) / 2.0;
  const cy = (extends_[3] + extends_[1]) / 2.0;
  return { left: extends_[0] - cx, top: extends_[1] - cy, right: extends_[2] - cx, bottom: extends_[3] - cy, cx, cy };
}

function writeVersion1(pattern: EmbPattern, f: ByteWriter): void {
  const chart = getThreadSet();
  f.stringUtf8(PES_VERSION_1_SIGNATURE);

  const { left, top, right, bottom, cx, cy } = centredBounds(pattern);

  const placeholderPecBlock = f.tell();
  f.int32le(0); // Placeholder for PEC BLOCK

  if (pattern.stitches.length === 0) {
    writePesHeaderV1(f, 0);
    f.int16le(0x0000);
    f.int16le(0x0000);
  } else {
    writePesHeaderV1(f, 1);
    f.int16le(0xffff);
    f.int16le(0x0000);
    writePesBlocks(f, pattern, chart, left, top, right, bottom, cx, cy);
  }

  const currentPosition = f.tell();
  f.seek(placeholderPecBlock, 0);
  f.int32le(currentPosition);
  f.seek(currentPosition, 0);

  writePec(pattern, f);
}

function writeVersion6(pattern: EmbPattern, f: ByteWriter): void {
  pattern.fixColorCount();
  const chart = pattern.threads;
  f.stringUtf8(PES_VERSION_6_SIGNATURE);

  const { left, top, right, bottom, cx, cy } = centredBounds(pattern);

  const placeholderPecBlock = f.tell();
  f.int32le(0); // Placeholder for PEC BLOCK

  if (pattern.stitches.length === 0) {
    writePesHeaderV6(pattern, f, chart, 0);
    f.int16le(0x0000);
    f.int16le(0x0000);
  } else {
    writePesHeaderV6(pattern, f, chart, 1);
    f.int16le(0xffff);
    f.int16le(0x0000);
    const log = writePesBlocks(f, pattern, chart, left, top, right, bottom, cx, cy) as Array<[number, number]>;
    // In version 6 there is some node, tree, order thing.
    f.int32le(0);
    f.int32le(0);
    for (let i = 0; i < log.length; i++) {
      f.int32le(i);
      f.int32le(0);
    }
  }

  const currentPosition = f.tell();
  f.seek(placeholderPecBlock, 0);
  f.int32le(currentPosition);
  f.seek(currentPosition, 0);
  const colorInfo = writePec(pattern, f);
  writePesAddendum(f, colorInfo);
  f.int16le(0x0000); // Found in version 6 not 5,4
}

function writePesHeaderV1(f: ByteWriter, distinctBlockObjects: number): void {
  f.int16le(0x01); // scale to fit
  f.int16le(0x01); // 0 = 100x100, 130x180 hoop
  f.int16le(distinctBlockObjects);
}

function writePesHeaderV6(pattern: EmbPattern, f: ByteWriter, chart: EmbThread[], distinctBlockObjects: number): void {
  f.int16le(0x01); // 0 = 100x100, 130x180 hoop
  f.stringUtf8("02"); // This is an 2-digit ascii number.
  for (const key of METADATA_KEYS) writePesString8(f, pattern.getMetadata(key, null));
  f.int16le(0); // OptimizeHoopChange = False
  f.int16le(0); // Design Page Is Custom = False
  f.int16le(0x64); // Hoop Width
  f.int16le(0x64); // Hoop Height
  f.int16le(0); // Use Existing Design Area = False
  f.int16le(0xc8); // designWidth
  f.int16le(0xc8); // designHeight
  f.int16le(0x64); // designPageSectionWidth
  f.int16le(0x64); // designPageSectionHeight
  f.int16le(0x64); // p6 # 100
  f.int16le(0x07); // designPageBackgroundColor
  f.int16le(0x13); // designPageForegroundColor
  f.int16le(0x01); // ShowGrid
  f.int16le(0x01); // WithAxes
  f.int16le(0x00); // SnapToGrid
  f.int16le(100); // GridInterval
  f.int16le(0x01); // p9 curves?
  f.int16le(0x00); // OptimizeEntryExitPoints
  f.int8(0); // fromImageStringLength
  //  String FromImageFilename
  f.float32le(1);
  f.float32le(0);
  f.float32le(0);
  f.float32le(1);
  f.float32le(0);
  f.float32le(0);
  f.int16le(0); // numberOfProgrammableFillPatterns
  f.int16le(0); // numberOfMotifPatterns
  f.int16le(0); // featherPatternCount
  const countThread = chart.length;
  f.int16le(countThread); // numberOfColors
  for (const thread of chart) writePesThread(f, thread);
  f.int16le(distinctBlockObjects); // number ofdistinct blocks
}

function writePesAddendum(f: ByteWriter, colorInfo: PecColorInfo): void {
  const colorIndexList = colorInfo[0];
  const rgbList = colorInfo[1];
  const count = colorIndexList.length;
  f.write(colorIndexList);
  if (count < 128) f.write(new Uint8Array(128 - count).fill(0x20));
  for (let s = 0; s < rgbList.length; s++) f.write(new Uint8Array(0x90));
  for (const r of rgbList) f.int24le(r);
}

/** write_pes_string_8: a length byte, then UTF-8. The length counts code points (at most 255), as in pystitch. */
function writePesString8(f: ByteWriter, string: unknown): void {
  if (string === null || string === undefined) {
    f.int8(0);
    return;
  }
  if (typeof string !== "string") throw new TypeError(`object of type '${typeof string}' has no len()`);
  let codePoints = Array.from(string);
  if (codePoints.length > 255) codePoints = codePoints.slice(0, 255);
  f.int8(codePoints.length);
  f.stringUtf8(codePoints.join(""));
}

function writePesString16(f: ByteWriter, string: string | null): void {
  if (string === null) {
    f.int16le(0);
    return;
  }
  f.int16le(Array.from(string).length);
  // 16 refers to the size write not the string encoding.
  f.stringUtf8(string);
}

function writePesThread(f: ByteWriter, thread: EmbThread): void {
  writePesString8(f, thread.catalogNumber);
  f.int8(thread.getRed());
  f.int8(thread.getGreen());
  f.int8(thread.getBlue());
  f.int8(0); // unknown
  f.int32le(0xa); // A is custom color
  writePesString8(f, thread.description);
  writePesString8(f, thread.brand);
  writePesString8(f, thread.chart);
}

function writePesBlocks(
  f: ByteWriter, pattern: EmbPattern, chart: Palette, left: number, top: number, right: number, bottom: number, cx: number, cy: number,
): Array<[number, number]> | null {
  if (pattern.stitches.length === 0) return null;

  writePesString16(f, EMB_ONE);
  const placeholder = writePesSewsegheader(f, left, top, right, bottom);
  f.int16le(0xffff);
  f.int16le(0x0000); // FFFF0000 means more blocks exist

  writePesString16(f, EMB_SEG);
  const [sections, colorlog] = writePesEmbsewsegSegments(f, pattern, chart, left, bottom, cx, cy);

  const currentPosition = f.tell();
  f.seek(placeholder, 0);
  f.int16le(sections);
  f.seek(currentPosition, 0); // patch final section count.

  // If there were addition embsewsegheaders or segments they would go here.

  f.int16le(0x0000);
  f.int16le(0x0000); // 00000000 means no more blocks.

  return colorlog;
}

/** int(v) for a float: truncation toward zero; Python raises on infinity and NaN. */
function pyInt(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError(`cannot convert float ${v} to integer`);
  return Math.trunc(v);
}

function writePesSewsegheader(f: ByteWriter, left: number, top: number, right: number, bottom: number): number {
  const width = right - left;
  const height = bottom - top;
  const hoopHeight = 1800;
  const hoopWidth = 1300;
  f.int16le(0); // left
  f.int16le(0); // top
  f.int16le(0); // right
  f.int16le(0); // bottom
  f.int16le(0); // left
  f.int16le(0); // top
  f.int16le(0); // right
  f.int16le(0); // bottom
  let transX = 0;
  let transY = 0;
  transX += 350;
  transY += 100 + height;
  transX += hoopWidth / 2;
  transY += hoopHeight / 2;
  transX += -width / 2;
  transY += -height / 2;
  f.float32le(1);
  f.float32le(0);
  f.float32le(0);
  f.float32le(1);
  f.float32le(transX);
  f.float32le(transY);

  f.int16le(1);
  f.int16le(0);
  f.int16le(0);
  f.int16le(pyInt(width));
  f.int16le(pyInt(height));
  f.write(new Uint8Array(8));

  const placeholderNeedsSectionData = f.tell();
  // sections
  f.int16le(0);
  return placeholderNeedsSectionData;
}

type Segment = [x: number, y: number];

/** get_as_segments_blocks: (points, colour code, flag) per stitch run (flag 0) or jump (flag 1). */
function* getAsSegmentsBlocks(pattern: EmbPattern, chart: Palette, adjustX: number, adjustY: number): Generator<[Segment[], number | null, number]> {
  let colorIndex = 0;
  let currentThread = pattern.getThreadOrFiller(colorIndex);
  colorIndex += 1;
  let colorCode = currentThread.findNearestColorIndex(chart);
  let stitchedX = 0;
  let stitchedY = 0;
  for (const commandBlock of pattern.getAsCommandBlocks()) {
    const block: Segment[] = [];
    const command = commandBlock[0][2] & COMMAND_MASK;
    let flag: number;
    if (command === JUMP) {
      block.push([stitchedX - adjustX, stitchedY - adjustY]);
      const lastPos = commandBlock[commandBlock.length - 1];
      block.push([lastPos[0] - adjustX, lastPos[1] - adjustY]);
      flag = 1;
    } else if (command === COLOR_CHANGE) {
      currentThread = pattern.getThreadOrFiller(colorIndex);
      colorIndex += 1;
      colorCode = currentThread.findNearestColorIndex(chart);
      continue;
    } else if (command === STITCH) {
      for (const stitch of commandBlock) {
        stitchedX = stitch[0];
        stitchedY = stitch[1];
        block.push([stitchedX - adjustX, stitchedY - adjustY]);
      }
      flag = 0;
    } else {
      continue;
    }
    yield [block, colorCode, flag];
  }
}

function writePesEmbsewsegSegments(
  f: ByteWriter, pattern: EmbPattern, chart: Palette, left: number, bottom: number, cx: number, cy: number,
): [number, Array<[number, number]>] {
  let section = 0;
  const colorlog: Array<[number, number]> = [];

  let previousColorCode: number | null = -1;
  let flag = -1;
  const adjustX = left + cx;
  const adjustY = bottom + cy;
  for (const segs of getAsSegmentsBlocks(pattern, chart, adjustX, adjustY)) {
    if (flag !== -1) f.int16le(0x8003); // section end.
    const segments = segs[0];
    const colorCode = segs[1];
    flag = segs[2];
    if (colorCode === null) throw new TypeError("no thread colour for a PES segment"); // write_int_16le(None)

    if (previousColorCode !== colorCode) {
      colorlog.push([section, colorCode]);
      previousColorCode = colorCode;
      // This must trigger first segment.
    }
    f.int16le(flag);
    f.int16le(colorCode);
    f.int16le(segments.length);
    for (const seg of segments) {
      f.int16le(pyInt(seg[0]));
      f.int16le(pyInt(seg[1]));
    }
    section += 1;
  }

  f.int16le(colorlog.length);
  for (const logItem of colorlog) {
    f.int16le(logItem[0]);
    f.int16le(logItem[1]);
  }

  return [section, colorlog]; // how many sections, how color transitions.
}

/**
 * write_embroidery for PES: merge `settings` with PesWriter's constants, normalize through the encoder when encode is
 * on, then write. `settings.version` is 1 (default, as pystitch) or 6; "1t"/"6t" or `truncated` write the short
 * variants. The source pattern is not modified when encoding (pystitch writes a normalized copy).
 */
export function writePes(pattern: EmbPattern, settings: WriterSettings = INKSTITCH_EXPORT_SETTINGS): Uint8Array {
  const merged = effectiveSettings("pes", settings);
  const source = shouldEncode("pes", merged) ? normalize(pattern, merged) : pattern;
  const out = new ByteWriter(4096);
  writeRaw(source, out, merged);
  return out.toUint8Array();
}
