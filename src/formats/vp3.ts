// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of Vp3Reader.py and Vp3Writer.py (pystitch 1.0.1). Units are 0.1 mm. VP3 is Husqvarna Viking / Pfaff.
//
// pystitch -> TS: read -> readVp3; vp3_read_colorblock -> readColorblock; vp3_read_thread -> readThread;
// read_vp3_string_8 / read_vp3_string_16 / skip_vp3_string -> readString8 / readString16 / skipString;
// write (+ write_embroidery's merge and normalize) -> writeVp3 (raw writer: writeRaw); write_file -> writeFile;
// write_design_block -> writeDesignBlock; write_vp3_colorblock -> writeColorblock; vp3_write_thread -> writeThread;
// write_stitches_block -> writeStitchesBlock; get_as_colorblocks -> getAsColorblocks.
//
// Truncated or corrupt input gives the same outcome as pystitch: a (partial) pattern where pystitch returns one,
// and an Error where pystitch raises (TypeError on None, ValueError, IndexError). Fields pystitch ignores never throw.
import { COLOR_CHANGE, COMMAND_MASK, END, FLAGS_MASK, JUMP, SEQUIN_EJECT, SEQUIN_MODE, STITCH, STOP, TRIM } from "../core/constants";
import { normalize } from "../core/encoder";
import { EmbPattern, type Stitch } from "../core/pattern";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings, shouldEncode, type WriterSettings } from "../core/settings";
import type { ReadLimitOptions } from "./exp";
import { EmbThread, pyRound } from "../core/thread";
import { ByteReader, signed16, signed8 } from "../io/reader";
import { ByteWriter } from "../io/writer";

function need(v: number | null, what: string): number {
  if (v === null) throw new Error(`Can't read this VP3 file: truncated ${what}.`);
  return v;
}

/**
 * read_vp3_string_8: a 16be length, then that many bytes of utf-8 text (null if not utf-8). A missing length is
 * Python's None, and stream.read(None) reads everything that is left, so it is -1 here.
 */
function readString8(f: ByteReader): string | null {
  const length = f.int16be();
  return f.string(length === null ? -1 : length);
}

/** skip_vp3_string. */
function skipString(f: ByteReader): void {
  f.seek(need(f.int16be(), "string"), 1);
}

/** signed32 of an unsigned 32-bit value. */
function signed32(b: number): number {
  b = b >>> 0;
  return b > 0x7fffffff ? b - 0x100000000 : b;
}

/** VP3Reader.vp3_read_thread. Returns the thread; its colour is the last one of the (normally single) colour list. */
function readThread(f: ByteReader): EmbThread {
  const thread = new EmbThread();
  const colors = need(f.uint8(), "thread");
  f.uint8(); // transition (ignored by pystitch, so a missing byte is fine)
  for (let m = 0; m < colors; m++) {
    thread.color = need(f.int24be(), "thread colour"); // pystitch: thread.color = None raises ValueError
    f.uint8(); // parts
    f.int16be(); // color_length
  }
  f.uint8(); // thread_type
  f.uint8(); // weight
  thread.catalogNumber = readString8(f);
  thread.description = readString8(f);
  thread.brand = readString8(f);
  return thread;
}

/** The IndexError pystitch would raise reading past the end of the stitch bytes. */
function at(bytes: Uint8Array, i: number): number {
  if (i >= bytes.length) throw new Error("Can't read this VP3 file: truncated stitch data.");
  return signed8(bytes[i]);
}

function readColorblock(f: ByteReader, out: EmbPattern, centerX: number, centerY: number): void {
  f.read(3); // \x00\x05\x00
  const distanceToNextBlock = need(f.int32be(), "colour block");
  const blockEndPosition = distanceToNextBlock + f.tell();

  const startPositionX = signed32(need(f.int32be(), "colour block")) / 100;
  const startPositionY = -(signed32(need(f.int32be(), "colour block")) / 100);
  const absX = startPositionX + centerX;
  const absY = startPositionY + centerY;
  if (absX !== 0 && absY !== 0) out.moveAbs(absX, absY);
  out.addThread(readThread(f));
  f.seek(15, 1);
  f.read(3); // \x0A\xF6\x00
  const stitchByteLength = blockEndPosition - f.tell();
  // A view of the raw bytes, read as signed on the fly (no number[] copy: a hostile block can be 30 MB).
  const stitchBytes = f.read(stitchByteLength);
  let i = 0;
  while (i < stitchBytes.length - 1) {
    let x = signed8(stitchBytes[i]);
    let y = signed8(stitchBytes[i + 1]);
    i += 2;
    if ((x & 0xff) !== 0x80) {
      out.stitch(x, y);
      continue;
    }
    if (y === 0x01) {
      x = signed16(((at(stitchBytes, i) & 0xff) << 8) | (at(stitchBytes, i + 1) & 0xff));
      i += 2;
      y = signed16(((at(stitchBytes, i) & 0xff) << 8) | (at(stitchBytes, i + 1) & 0xff));
      i += 2;
      out.stitch(x, y);
      i += 2; // Final element is typically 0x80 0x02, this is skipped regardless of its value.
    } else if (y === 0x02) {
      // Only seen after 80 01 and should have been skipped. Has no known effect.
    } else if (y === 0x03) {
      out.trim();
    }
  }
}

/** Vp3Reader.read. Throws an Error where pystitch raises on a truncated file. */
export function readVp3(bytes: Uint8Array | ArrayBuffer, opts: ReadLimitOptions | null = {}): EmbPattern {
  const f = new ByteReader(bytes);
  const out = new EmbPattern();
  out.maxStitches = opts?.maxStitches ?? null;
  f.read(6); // magic code: %vsm%\0
  skipString(f); // "Produced by     Software Ltd"
  f.seek(7, 1);
  skipString(f); // "" comments and note string.
  f.seek(32, 1);
  const centerX = signed32(need(f.int32be(), "header")) / 100;
  const centerY = -(signed32(need(f.int32be(), "header")) / 100);
  f.seek(27, 1);
  skipString(f); // ""
  f.seek(24, 1);
  skipString(f); // "Produced by     Software Ltd"
  const countColors = need(f.int16be(), "header");
  for (let i = 0; i < countColors; i++) {
    readColorblock(f, out, centerX, centerY);
    if (i + 1 < countColors) out.colorChange(); // Don't add the color change on the final read.
  }
  out.end();
  return out;
}

// Python's len(str) counts code points, not UTF-16 units.
const codePoints = (s: string): number => Array.from(s).length;

function writeString8(f: ByteWriter, s: string): void {
  f.int16be(codePoints(s));
  f.stringUtf8(s);
}

function writeString16(f: ByteWriter, s: string): void {
  f.int16be(codePoints(s) * 2);
  f.string(s, "UTF-16BE");
}

function patchByteOffset(f: ByteWriter, offset: number): void {
  const currentPos = f.tell();
  f.seek(offset, 0); // Absolute position seek.
  f.int32be(currentPos - offset - 4); // 4 bytes int32
  f.seek(currentPos, 0);
}

type VColorBlock = [stitches: Stitch[], thread: EmbThread];

/** Vp3Writer.get_as_colorblocks: a block starts at each COLOR_CHANGE stitch (which belongs to the next block). */
function getAsColorblocks(pattern: EmbPattern): VColorBlock[] {
  const blocks: VColorBlock[] = [];
  let threadIndex = 0;
  let lastPos = 0;
  const end = pattern.stitches.length;
  pattern.stitches.forEach((stitch, pos) => {
    if ((stitch[2] & COMMAND_MASK) !== COLOR_CHANGE) return;
    const thread = pattern.getThreadOrFiller(threadIndex);
    threadIndex += 1;
    blocks.push([pattern.stitches.slice(lastPos, pos), thread]);
    lastPos = pos;
  });
  blocks.push([pattern.stitches.slice(lastPos, end), pattern.getThreadOrFiller(threadIndex)]);
  return blocks;
}

function writeThread(f: ByteWriter, thread: EmbThread): void {
  f.write([0x01, 0x00]); // Single color, no transition.
  f.int24be(thread.color);
  f.write([0x00, 0x00, 0x00, 0x05, 0x28]); // no parts, no length, Rayon 40-weight
  writeString8(f, thread.catalogNumber !== null ? thread.catalogNumber : "");
  writeString8(f, thread.description !== null ? thread.description : thread.hexColor());
  writeString8(f, thread.brand !== null ? thread.brand : "");
}

function writeStitchesBlock(f: ByteWriter, stitches: Stitch[], firstPosX: number, firstPosY: number): void {
  // The 0, x, 0 bytes come before placeholders
  f.write([0x00, 0x01, 0x00]);
  const placeholder = f.tell();
  f.int32be(0);
  f.write([0x0a, 0xf6, 0x00]);
  let lastX = firstPosX;
  let lastY = firstPosY;

  for (const stitch of stitches) {
    const x = stitch[0];
    const y = stitch[1];
    const flags = stitch[2] & COMMAND_MASK;
    const alt = stitch[2] & FLAGS_MASK;
    if (flags === END) {
      // This is a trim command. The machine does not autotrim. Consequently writers add this explicit trim command.
      f.write([0x80, 0x03]);
      break;
    } else if (flags === COLOR_CHANGE) {
      continue; // Colorchange commands divided the pattern into colorblocks.
    } else if (flags === TRIM) {
      f.write([0x80, 0x03]);
      continue;
    } else if (flags === SEQUIN_MODE || flags === SEQUIN_EJECT || flags === STOP) {
      continue;
    } else if (flags === JUMP) {
      continue; // VP3 has no jump commands. It moves to the location without needing to block the needlebar.
    }
    const dx = Math.trunc(pyRound(x - lastX));
    const dy = Math.trunc(pyRound(y - lastY));
    lastX += dx;
    lastY += dy;
    if (flags === STITCH) {
      if (dx >= -127 && dx <= 127 && dy >= -127 && dy <= 127 && alt === 0) {
        f.int8(dx);
        f.int8(dy);
      } else {
        f.write([0x80, 0x01]);
        f.int16be(dx);
        f.int16be(dy);
        f.write([0x80, 0x02]);
      }
    }
  }
  patchByteOffset(f, placeholder);
}

function writeColorblock(f: ByteWriter, first: boolean, centerX: number, centerY: number, stitches: Stitch[], thread: EmbThread): void {
  f.write([0x00, 0x05, 0x00]);
  const placeholder = f.tell();
  f.int32be(0);

  let firstPosX: number;
  let firstPosY: number;
  let lastPosX: number;
  let lastPosY: number;
  if (stitches.length > 0) {
    firstPosX = stitches[0][0];
    firstPosY = stitches[0][1];
    if (first) {
      firstPosX = 0;
      firstPosY = 0;
    }
    lastPosX = stitches[stitches.length - 1][0];
    lastPosY = stitches[stitches.length - 1][1];
  } else {
    firstPosX = 0;
    firstPosY = 0;
    lastPosX = 0;
    lastPosY = 0;
  }
  const startFromCenterX = firstPosX - centerX;
  const startFromCenterY = -(firstPosY - centerY);
  f.int32be(Math.trunc(startFromCenterX) * 100);
  f.int32be(Math.trunc(startFromCenterY) * 100);

  writeThread(f, thread);

  const blockShiftX = lastPosX - firstPosX;
  const blockShiftY = -(lastPosY - firstPosY);
  f.int32be(Math.trunc(blockShiftX) * 100);
  f.int32be(Math.trunc(blockShiftY) * 100);

  writeStitchesBlock(f, stitches, firstPosX, firstPosY);

  f.int8(0);
  patchByteOffset(f, placeholder);
}

function writeDesignBlock(f: ByteWriter, extends_: readonly number[], colorblocks: VColorBlock[]): void {
  f.write([0x00, 0x03, 0x00]);
  const placeholder = f.tell();
  f.int32be(0);

  const width = extends_[2] - extends_[0];
  const height = extends_[3] - extends_[1];
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = extends_[2] - halfWidth;
  const centerY = extends_[3] - halfHeight;

  f.int32be(Math.trunc(centerX) * 100); // initial x
  f.int32be(Math.trunc(centerY) * -100); // initial y
  f.int8(0);
  f.int8(0);
  f.int8(0);

  // extends 2
  f.int32be(Math.trunc(halfWidth) * -100);
  f.int32be(Math.trunc(halfWidth) * 100);
  f.int32be(Math.trunc(halfHeight) * -100);
  f.int32be(Math.trunc(halfHeight) * 100);

  f.int32be(Math.trunc(width) * 100);
  f.int32be(Math.trunc(height) * 100);
  writeString16(f, ""); // This is notes and settings string.

  f.write([0x64, 0x64]);
  f.int32be(4096);
  f.int32be(0);
  f.int32be(0);
  f.int32be(4096);

  f.write([0x78, 0x78, 0x50, 0x50, 0x01, 0x00]); // "xxPP\x01\x00"

  writeString16(f, "Produced by     Software Ltd");

  f.int16be(colorblocks.length);

  let first = true;
  for (const [stitches, thread] of colorblocks) {
    writeColorblock(f, first, centerX, centerY, stitches, thread);
    first = false;
  }
  patchByteOffset(f, placeholder);
}

function writeFile(pattern: EmbPattern, f: ByteWriter): void {
  f.write([0x00, 0x02, 0x00]);
  const placeholder = f.tell();
  f.int32be(0); // placeholder: the end of the final block, not entire bytes.

  writeString16(f, ""); // global notes and settings string.

  const countStitches = pattern.stitches.length;
  const colorblocks = getAsColorblocks(pattern);

  const extends_ = pattern.bounds();
  if (!extends_.every(Number.isFinite)) {
    // pystitch: int(inf) raises OverflowError.
    throw new Error("Can't write a VP3 file for an empty pattern.");
  }
  f.int32be(Math.trunc(extends_[2] * 100)); // right
  f.int32be(Math.trunc(extends_[1] * -100)); // -top
  f.int32be(Math.trunc(extends_[0] * 100)); // left
  f.int32be(Math.trunc(extends_[3] * -100)); // -bottom

  // Total stitch count, sans end command.
  f.int32be(countStitches - pattern.countStitchCommands(END));
  f.int8(0);
  f.int8(colorblocks.length);
  f.int8(12); // 0xC
  f.int8(0);

  f.int8(1); // Number of designs.
  writeDesignBlock(f, extends_, colorblocks);
  patchByteOffset(f, placeholder);
}

/** The ported Vp3Writer.write: writes `pattern` as is (no normalizing); fixes the colour count like pystitch. */
function writeRaw(pattern: EmbPattern, f: ByteWriter): void {
  pattern.fixColorCount();
  f.stringUtf8("%vsm%");
  f.int8(0);
  writeString16(f, "Produced by     Software Ltd");
  writeFile(pattern, f);
}

/**
 * write_embroidery for VP3: merge `settings` with Vp3Writer's constants, normalize through the encoder when encode
 * is on, then write. The source pattern is not modified. Missing threads are filled with the deterministic filler
 * colours (pystitch picks random ones).
 */
export function writeVp3(pattern: EmbPattern, settings: WriterSettings = INKSTITCH_EXPORT_SETTINGS): Uint8Array {
  const merged = effectiveSettings("vp3", settings);
  const source = shouldEncode("vp3", merged) ? normalize(pattern, merged) : pattern.copy();
  const out = new ByteWriter(4096);
  writeRaw(source, out);
  return out.toUint8Array();
}
