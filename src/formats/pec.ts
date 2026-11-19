// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of PecReader.py and PecWriter.py (pystitch 1.0.1): the PEC block every PES file carries. Units are 0.1 mm.
//
// pystitch -> TS (reader): read_pec -> readPecBody; read_pec_graphics -> readPecGraphics; process_pec_colors ->
// processPecColors; process_pec_table -> processPecTable; map_pec_colors -> mapPecColors; signed12, signed7;
// read_pec_stitches -> readPecStitches.
// pystitch -> TS (writer): write_pec -> writePec; write_pec_header -> writePecHeader; write_pec_block -> writePecBlock;
// write_pec_graphics -> writePecGraphics; write_value -> writeValue; write_trimjump / write_jump / write_stitch;
// pec_encode -> pecEncode; exceptions.TooManyColorChangesError -> TooManyColorChangesError.
// PEC is internal to PES here (a bare .pec file is not a supported format), so the stand-alone .pec entry points
// PecReader.read and PecWriter.write are not ported; readPes reads a "#PEC0001" file through the same path PesReader.read does.
import { COLOR_CHANGE, COMMAND_MASK, END, JUMP, STITCH, STOP, TRIM } from "../core/constants";
import { EmbPattern } from "../core/pattern";
import { EmbThread, buildUniquePalette, pyRound } from "../core/thread";
import { getThreadSet } from "../threads/pec";
import { ByteReader, pyStrip } from "../io/reader";
import { ByteWriter } from "../io/writer";
import { drawScaled, getBlank, type Extends } from "./pecGraphics";

// ------------------------------------------------------------------------------------------------ PecReader

const READ_JUMP_CODE = 0x10;
const READ_TRIM_CODE = 0x20;
const READ_FLAG_LONG = 0x80;

/** A pec_graphic_N metadata value: (graphic bytes, byte stride, thread or null), as pystitch's tuple. */
export type PecGraphicMetadata = [graphic: Uint8Array, stride: number, thread: EmbThread | null];

function truncated(what: string): Error {
  return new Error(`Can't read this PES file: truncated ${what}.`);
}

/**
 * read_pec: the PEC block from the current position (just before "LA:"). `pesChart` is the thread list a PES header
 * carried (it is consumed in tabled mode, as in pystitch). Throws where pystitch raises on missing data.
 */
export function readPecBody(f: ByteReader, out: EmbPattern, pesChart: EmbThread[] | null = null): void {
  f.seek(3, 1); // LA:
  const label = f.string(16); // Label
  if (label !== null) out.metadata("Name", pyStrip(label));
  f.seek(0xf, 1); // Dunno, spaces then 0xFF 0x00
  const pecGraphicByteStride = f.uint8();
  const pecGraphicIconHeight = f.uint8();
  f.seek(0xc, 1);
  const colorChanges = f.uint8();
  if (colorChanges === null || pecGraphicByteStride === null || pecGraphicIconHeight === null) {
    throw truncated("PEC header"); // pystitch: TypeError on None + 1
  }
  const countColors = colorChanges + 1; // PEC uses cc - 1, 0xFF means 0.
  const colorBytes = Uint8Array.from(f.read(countColors));
  const threads: Array<EmbThread | null> = [];
  mapPecColors(colorBytes, out, pesChart, threads);
  f.seek(0x1d0 - colorChanges, 1);
  const blockLength = f.int24le();
  if (blockLength === null) throw truncated("PEC stitch block"); // pystitch: TypeError on None - 5
  const stitchBlockEnd = blockLength - 5 + f.tell();
  // The end of this value is already 5 into the stitchblock.

  // 3 bytes, '\x31\xff\xf0', 6 2-byte shorts. 15 total.
  f.seek(0x0f, 1);
  readPecStitches(f, out);
  f.seek(stitchBlockEnd, 0);

  const byteSize = pecGraphicByteStride * pecGraphicIconHeight;

  readPecGraphics(f, out, byteSize, pecGraphicByteStride, countColors + 1, threads);
}

/** read_pec_graphics: the overview icon and one icon per colour, as pec_graphic_N metadata. */
function readPecGraphics(f: ByteReader, out: EmbPattern, size: number, stride: number, count: number, values: Array<EmbThread | null>): void {
  const v: Array<EmbThread | null> = [null, ...values];
  for (let i = 0; i < count; i++) {
    const graphic = Uint8Array.from(f.read(size));
    if (i >= v.length) throw truncated("PEC colour table"); // pystitch: IndexError
    const value: PecGraphicMetadata = [graphic, stride, v[i]];
    out.metadata(`pec_graphic_${i}`, value);
  }
}

/** add_thread(None) appends a default (black) EmbThread. */
function addThreadOrDefault(out: EmbPattern, thread: EmbThread | null): void {
  out.addThread(thread ?? new EmbThread());
}

/** process_pec_colors: each colour byte is an index (modulo 65) into the PEC thread table. */
function processPecColors(colorbytes: Uint8Array, out: EmbPattern, values: Array<EmbThread | null>): void {
  const threadSet = getThreadSet();
  const maxValue = threadSet.length;
  for (const byte of colorbytes) {
    const threadValue = threadSet[byte % maxValue];
    addThreadOrDefault(out, threadValue);
    values.push(threadValue);
  }
}

/** process_pec_table: this is how PEC actually allocates pre-defined threads to blocks. */
function processPecTable(colorbytes: Uint8Array, out: EmbPattern, chart: EmbThread[], values: Array<EmbThread | null>): void {
  const threadSet = getThreadSet();
  const maxValue = threadSet.length;
  const threadMap = new Map<number, EmbThread | null>();
  for (let i = 0; i < colorbytes.length; i++) {
    const colorIndex = colorbytes[i] % maxValue;
    let threadValue = threadMap.get(colorIndex) ?? null;
    if (threadValue === null) {
      if (chart.length > 0) {
        threadValue = chart.shift() as EmbThread;
      } else {
        threadValue = threadSet[colorIndex];
      }
      threadMap.set(colorIndex, threadValue);
    }
    addThreadOrDefault(out, threadValue);
    values.push(threadValue);
  }
}

/** map_pec_colors */
function mapPecColors(colorbytes: Uint8Array, out: EmbPattern, chart: EmbThread[] | null, values: Array<EmbThread | null>): void {
  if (chart === null || chart.length === 0) {
    // Reading pec colors.
    processPecColors(colorbytes, out, values);
  } else if (chart.length >= colorbytes.length) {
    // Reading threads in 1 : 1 mode.
    for (const thread of chart) {
      out.addThread(thread);
      values.push(thread);
    }
  } else {
    // Reading tabled mode threads.
    processPecTable(colorbytes, out, chart, values);
  }
}

export function signed12(b: number): number {
  b &= 0xfff;
  if (b > 0x7ff) return -0x1000 + b;
  return b;
}

export function signed7(b: number): number {
  if (b > 63) return -128 + b;
  return b;
}

/** read_pec_stitches: until the 0xFF 0x00 end mark or the end of the data, then END. */
function readPecStitches(f: ByteReader, out: EmbPattern): void {
  for (;;) {
    const val1 = f.uint8();
    let val2 = f.uint8();
    if ((val1 === 0xff && val2 === 0x00) || val2 === null || val1 === null) break; // val1 is null only when val2 is
    if (val1 === 0xfe && val2 === 0xb0) {
      f.seek(1, 1);
      out.colorChange(0, 0);
      continue;
    }
    let jump = false;
    let trim = false;
    let x: number;
    let y: number;
    if ((val1 & READ_FLAG_LONG) !== 0) {
      if ((val1 & READ_TRIM_CODE) !== 0) trim = true;
      if ((val1 & READ_JUMP_CODE) !== 0) jump = true;
      const code = (val1 << 8) | val2;
      x = signed12(code);
      val2 = f.uint8();
      if (val2 === null) break;
    } else {
      x = signed7(val1);
    }

    if ((val2 & READ_FLAG_LONG) !== 0) {
      if ((val2 & READ_TRIM_CODE) !== 0) trim = true;
      if ((val2 & READ_JUMP_CODE) !== 0) jump = true;
      const val3 = f.uint8();
      if (val3 === null) break;
      const code = (val2 << 8) | val3;
      y = signed12(code);
    } else {
      y = signed7(val2);
    }
    if (jump) {
      out.move(x, y);
    } else if (trim) {
      out.trim();
      out.move(x, y);
    } else {
      out.stitch(x, y);
    }
  }
  out.end();
}

// ------------------------------------------------------------------------------------------------ PecWriter

export const MASK_07_BIT = 0b01111111;
export const JUMP_CODE = 0b00010000;
export const TRIM_CODE = 0b00100000;
export const FLAG_LONG = 0b10000000;
export const PEC_ICON_WIDTH = 48;
export const PEC_ICON_HEIGHT = 38;

const GROUP_LONG = false;

/** pystitch.exceptions.TooManyColorChangesError: a PEC colour table holds at most 256 entries. */
export class TooManyColorChangesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooManyColorChangesError";
  }
}

/** (color_index_list, rgb_list) as write_pec_header returns them; the index list includes the count prefix. */
export type PecColorInfo = [colorIndexList: number[], rgbList: number[]];

/** int(round(v)) for a float: Python raises on infinity (OverflowError) and NaN (ValueError). */
function intRound(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError(`cannot convert float ${v} to integer`);
  return pyRound(v);
}

/** write_pec: the PEC header, stitch block and thumbnails. Returns the colour info PES version 6 appends. */
export function writePec(pattern: EmbPattern, f: ByteWriter, threadlist: EmbThread[] | null = null): PecColorInfo {
  const extends_ = pattern.bounds();
  if (threadlist === null) {
    pattern.fixColorCount();
    threadlist = pattern.threads;
  }
  const colorInfo = writePecHeader(pattern, f, threadlist);
  writePecBlock(pattern, f, extends_);
  writePecGraphics(pattern, f, extends_);
  return colorInfo;
}

function writePecHeader(pattern: EmbPattern, f: ByteWriter, threadlist: EmbThread[]): PecColorInfo {
  const raw = pattern.getMetadata("name", "Untitled");
  if (typeof raw !== "string") throw new TypeError("expected string or bytes-like object"); // re.sub on a non-str
  // the usage of other characters can mess up the output file
  const name = raw.replace(/[^A-Za-z0-9]+/g, "") || "Untitled";
  f.stringUtf8(`LA:${name.slice(0, 8).padEnd(16, " ")}\r`); // "LA:%-16s\r" % name[:8]
  f.write(Uint8Array.of(0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0xff, 0x00));
  f.int8(Math.trunc(PEC_ICON_WIDTH / 8)); // PEC BYTE STRIDE
  f.int8(Math.trunc(PEC_ICON_HEIGHT)); // PEC ICON HEIGHT

  const threadSet = getThreadSet();

  const colorIndexList = buildUniquePalette(threadSet, pattern.threads) as number[];

  const rgbList = threadlist.map((thread) => thread.color);

  const currentThreadCount = colorIndexList.length;
  if (currentThreadCount !== 0) {
    f.write(Uint8Array.of(0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20));
    const addValue = currentThreadCount - 1;
    colorIndexList.unshift(addValue);
    if (colorIndexList[0] > 255) {
      const numColorChanges = colorIndexList.length;
      throw new TooManyColorChangesError(`Too many color changes, (${numColorChanges} out of bounds (0, 255)`);
    }
    f.write(colorIndexList);
  } else {
    f.write(Uint8Array.of(0x20, 0x20, 0x20, 0x20, 0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xff));
  }

  if (currentThreadCount < 463) f.write(new Uint8Array(463 - currentThreadCount).fill(0x20)); // 520
  return [colorIndexList, rgbList];
}

function writePecBlock(pattern: EmbPattern, f: ByteWriter, extends_: Extends): void {
  const width = extends_[2] - extends_[0];
  const height = extends_[3] - extends_[1];

  const stitchBlockStartPosition = f.tell();
  f.write(Uint8Array.of(0x00, 0x00));
  f.int24le(0); // Space holder.
  f.write(Uint8Array.of(0x31, 0xff, 0xf0));
  f.int16le(intRound(width));
  f.int16le(intRound(height));
  f.int16le(0x1e0);
  f.int16le(0x1b0);
  writeJump(f, 0 - intRound(extends_[0]), 0 - intRound(extends_[1]));
  pecEncode(pattern, f);

  const stitchBlockLength = f.tell() - stitchBlockStartPosition;

  const currentPosition = f.tell();
  f.seek(stitchBlockStartPosition + 2, 0);
  f.int24le(stitchBlockLength);
  f.seek(currentPosition, 0);
}

/** write_pec_graphics: the overview icon (every stitch block), then one icon per colour block (its stitches). */
function writePecGraphics(pattern: EmbPattern, f: ByteWriter, extends_: Extends): void {
  let blank = getBlank();
  for (const block of pattern.getAsStitchblock()) {
    const stitches = block[0];
    drawScaled(extends_, stitches, blank, 6, 4);
  }
  f.write(Uint8Array.from(blank));

  for (const block of pattern.getAsColorblocks()) {
    const stitches = block[0].filter((s) => s[2] === STITCH);
    blank = getBlank(); // [ 0 ] * 6 * 38
    drawScaled(extends_, stitches, blank, 6);
    f.write(Uint8Array.from(blank));
  }
}

function writeValue(f: ByteWriter, value: number, long = false, flag = 0): void {
  if (!long && -64 < value && value < 63) {
    f.write(Uint8Array.of(value & MASK_07_BIT));
  } else {
    value &= 0b0000111111111111;
    value |= 0b1000000000000000;
    value |= flag << 8;
    f.write(Uint8Array.of((value >> 8) & 0xff, value & 0xff));
  }
}

function writeTrimjump(f: ByteWriter, dx: number, dy: number): void {
  writeValue(f, dx, true, TRIM_CODE);
  writeValue(f, dy, true, TRIM_CODE);
}

function writeJump(f: ByteWriter, dx: number, dy: number): void {
  writeValue(f, dx, true, JUMP_CODE);
  writeValue(f, dy, true, JUMP_CODE);
}

function writeStitch(f: ByteWriter, dx: number, dy: number): void {
  const long = GROUP_LONG && -64 < dx && dx < 63 && -64 < dy && dy < 63;
  writeValue(f, dx, long);
  writeValue(f, dy, long);
}

function pecEncode(pattern: EmbPattern, f: ByteWriter): void {
  let colorTwo = true;
  let jumping = true;
  let init = true;
  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const x = stitch[0];
    const y = stitch[1];
    const data = stitch[2] & COMMAND_MASK;
    const dx = intRound(x - xx);
    const dy = intRound(y - yy);
    xx += dx;
    yy += dy;
    if (data === STITCH) {
      if (jumping) {
        if (dx !== 0 && dy !== 0) writeStitch(f, 0, 0);
        jumping = false;
      }
      writeStitch(f, dx, dy);
    } else if (data === JUMP) {
      jumping = true;
      if (init) {
        writeJump(f, dx, dy);
      } else {
        writeTrimjump(f, dx, dy);
      }
    } else if (data === COLOR_CHANGE) {
      if (jumping) {
        writeStitch(f, 0, 0);
        jumping = false;
      }
      f.write(Uint8Array.of(0xfe, 0xb0));
      f.write(Uint8Array.of(colorTwo ? 0x02 : 0x01));
      colorTwo = !colorTwo;
    } else if (data === STOP) {
      // These will already be processed into duplicate colors.
    } else if (data === TRIM) {
      // pass
    } else if (data === END) {
      f.write(Uint8Array.of(0xff));
      break;
    }
    init = false;
  }
}
