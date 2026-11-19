// The safe public surface: never hangs, crashes or hands back garbage on bad input, and warns before a conversion
// loses information.
import { COLOR_CHANGE, COMMAND_MASK, JUMP, STITCH, STOP, TRIM } from "./core/constants";
import { normalize } from "./core/encoder";
import { EmbPattern, StitchLimitError } from "./core/pattern";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings, writerDefaults, type WriterSettings } from "./core/settings";
import { detectFormat, fileExtension, FORMATS, type Format } from "./detect";
import { readDst, writeDst } from "./formats/dst";
import { readExp, writeExp } from "./formats/exp";
import { readJef, writeJef } from "./formats/jef";
import { TooManyColorChangesError } from "./formats/pec";
import { readPes, writePes } from "./formats/pes";
import { readVp3, writeVp3 } from "./formats/vp3";
import { isIntact, jefColorCount } from "./integrity";
import { conversionWarnings, countColorBlocks, type Warning } from "./warnings";

export const MAX_STITCHES = 1_000_000;
export const MAX_BYTES = 30 * 1024 * 1024;
/** More colours than this in a header is not a real design. */
const MAX_THREADS = 5000;

export type ReadErrorCode = "empty" | "unknown_format" | "corrupt" | "too_large";
export type WriteErrorCode = "empty_design" | "too_many_colors" | "unsupported_option" | "write_failed" | "too_large";

export const READ_MESSAGES: Readonly<Record<ReadErrorCode, string>> = Object.freeze({
  empty: "This file is empty.",
  unknown_format: "We can't read this file. It doesn't look like a PES, DST, JEF, EXP or VP3 embroidery file.",
  corrupt: "We can't read this file. It looks damaged or incomplete.",
  too_large: "This design is too large to convert in the browser (limit: 1,000,000 stitches or 30 MB).",
});

export const WRITE_MESSAGES: Readonly<Record<WriteErrorCode, string>> = Object.freeze({
  empty_design: "This design has no stitches, so there is nothing to write.",
  too_many_colors: "This design has more than 256 colours, which is more than PES files can hold.",
  unsupported_option: "That option isn't supported for this format.",
  write_failed: "We couldn't write this file.",
  too_large: "This design is too large to convert in the browser (limit: 1,000,000 stitches).",
});

export class EmbroideryReadError extends Error {
  readonly code: ReadErrorCode;
  constructor(code: ReadErrorCode, message?: string) {
    super(message ?? READ_MESSAGES[code]);
    this.name = "EmbroideryReadError";
    this.code = code;
  }
}

export class EmbroideryWriteError extends Error {
  readonly code: WriteErrorCode;
  constructor(code: WriteErrorCode, message?: string) {
    super(message ?? WRITE_MESSAGES[code]);
    this.name = "EmbroideryWriteError";
    this.code = code;
  }
}

export interface WriteOptions {
  pesVersion?: 1 | 6;
}

// pystitch has no stitch limit; the API passes MAX_STITCHES so a hostile file stops decoding early.
const LIMIT = { maxStitches: MAX_STITCHES };
const READERS: Record<Format, (b: Uint8Array) => EmbPattern> = {
  pes: (b) => readPes(b, LIMIT),
  dst: (b) => readDst(b, LIMIT),
  jef: (b) => readJef(b, LIMIT),
  exp: (b) => readExp(b, LIMIT),
  vp3: (b) => readVp3(b, LIMIT),
};

/** True when the pattern has at least one real stitch (a lone END or a run of jumps is an empty design). */
function hasStitches(pattern: EmbPattern): boolean {
  return pattern.stitches.some((s) => (s[2] & COMMAND_MASK) === STITCH);
}

export function readEmbroidery(bytes: Uint8Array, filename?: string): EmbPattern {
  if (bytes.length === 0) throw new EmbroideryReadError("empty");
  if (bytes.length > MAX_BYTES) throw new EmbroideryReadError("too_large");
  const format = detectFormat(bytes, filename);
  // Under 4 bytes with an embroidery extension: a cut-off file, not an unknown one.
  if (format === null && bytes.length < 4 && (FORMATS as readonly string[]).includes(fileExtension(filename))) {
    throw new EmbroideryReadError("corrupt");
  }
  if (format === null) throw new EmbroideryReadError("unknown_format");
  // A DST record is 3 bytes after the 512-byte header: refuse before allocating millions of stitches.
  if (format === "dst" && (bytes.length - 512) / 3 > MAX_STITCHES) throw new EmbroideryReadError("too_large");
  // JefReader loops once per claimed colour: a header can claim millions with nothing behind them.
  if (format === "jef" && jefColorCount(bytes) > MAX_THREADS) throw new EmbroideryReadError("too_large");
  // The readers return a partial design when a file is cut off; the structural markers say whether it was.
  if (!isIntact(format, bytes)) throw new EmbroideryReadError("corrupt");
  let pattern: EmbPattern;
  try {
    pattern = READERS[format](bytes);
  } catch (e) {
    if (e instanceof StitchLimitError) throw new EmbroideryReadError("too_large");
    throw new EmbroideryReadError("corrupt");
  }
  if (pattern.stitches.length > MAX_STITCHES) throw new EmbroideryReadError("too_large");
  if (!hasStitches(pattern)) throw new EmbroideryReadError("corrupt");
  pattern.maxStitches = null; // the reader's safety limit must not follow the caller's pattern around
  return pattern;
}

/** ASCII only: NFKD, strip combining marks, drop anything left outside printable ASCII. */
const TRANSLITERATE: Readonly<Record<string, string>> = {
  "\u0131": "i", "\u0130": "I", "\u00df": "ss", "\u0142": "l", "\u0141": "L", "\u00f8": "o", "\u00d8": "O",
  "\u00e6": "ae", "\u00c6": "AE", "\u0153": "oe", "\u0152": "OE", "\u0111": "d", "\u0110": "D", "\u00fe": "th", "\u00de": "TH",
};
export function toAscii(s: string): string {
  return s
    .replace(/[\u0131\u0130\u00df\u0142\u0141\u00f8\u00d8\u00e6\u00c6\u0153\u0152\u0111\u0110\u00fe\u00de]/g, (c) => TRANSLITERATE[c])
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "");
}

function cloneThread<T extends object>(t: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(t) as object) as T, t);
}

/** A copy of the pattern whose names, descriptions, brands and catalogue numbers are ASCII. The input is untouched. */
function asciiCopy(pattern: EmbPattern, forDst = false): EmbPattern {
  const copy = pattern.copy();
  for (const key of Object.keys(copy.extras)) {
    const v = copy.extras[key];
    if (typeof v === "string") copy.extras[key] = toAscii(v);
  }
  // The DST "LA:" field is 16 characters; a longer name would push the header past its 512 bytes.
  const name = copy.extras.name;
  if (forDst && typeof name === "string") copy.extras.name = name.slice(0, 16);
  copy.threads = copy.threads.map((t) => {
    const c = cloneThread(t);
    for (const f of ["description", "catalogNumber", "details", "brand", "chart", "weight"] as const) {
      const v = c[f];
      if (typeof v === "string") c[f] = toAscii(v);
    }
    return c;
  });
  return copy;
}

/**
 * Upper bound of the stitches the encoder produces for patterns the readers produce, without running it. Hand-built
 * patterns can exceed it (sequin ejects, tie-on/off, matrix commands), which is why the writer also checks the real
 * count (see writeEmbroidery). Per input stitch: itself, its split moves
 * (ceil(dist / limit) - 1), +1 for the jump the encoder adds before the first stitch after a trim, colour change,
 * stop or jump (full_jump), and +1 for a trim it may insert at a jump; +2 per colour change or stop (the colour
 * change plus its trim and jump); plus the END. Non-finite coordinates give Infinity.
 */
export function estimateEncodedStitches(pattern: EmbPattern, format: Format): number {
  const c = writerDefaults(format);
  const maxStitch = c.MAX_STITCH_DISTANCE ?? 127;
  const maxJump = c.MAX_JUMP_DISTANCE ?? maxStitch;
  let total = 1;
  let px = 0;
  let py = 0;
  let needsJump = true;
  for (const s of pattern.stitches) {
    const x = s[0];
    const y = s[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
    const cmd = s[2] & COMMAND_MASK;
    const d = Math.max(Math.abs(x - px), Math.abs(y - py));
    const limit = cmd === JUMP ? maxJump : maxStitch;
    total += 1 + (d > limit ? Math.ceil(d / limit) - 1 : 0);
    if (cmd === STITCH) {
      if (needsJump) total += 1;
      needsJump = false;
    } else if (cmd === TRIM) {
      needsJump = true;
    } else if (cmd === JUMP) {
      needsJump = true;
      total += 1;
    } else if (cmd === COLOR_CHANGE || cmd === STOP) {
      needsJump = true;
      total += 2;
    }
    if (total > MAX_STITCHES) return total;
    px = x;
    py = y;
  }
  return total;
}

export function writeEmbroidery(pattern: EmbPattern, format: Format, opts: WriteOptions | null = {}): Uint8Array {
  opts = opts ?? {};
  if (!(FORMATS as readonly string[]).includes(format)) throw new EmbroideryWriteError("unsupported_option");
  if (!hasStitches(pattern)) throw new EmbroideryWriteError("empty_design");
  if (opts.pesVersion !== undefined && opts.pesVersion !== 1 && opts.pesVersion !== 6) {
    throw new EmbroideryWriteError("unsupported_option", "PES version must be 1 or 6.");
  }
  const estimate = estimateEncodedStitches(pattern, format);
  if (estimate === Infinity && pattern.stitches.some((st) => !Number.isFinite(st[0]) || !Number.isFinite(st[1]))) {
    throw new EmbroideryWriteError("write_failed", "This design has invalid coordinates, so it can't be written.");
  }
  if (estimate > MAX_STITCHES) throw new EmbroideryWriteError("too_large");
  if (format === "pes" && countColorBlocks(pattern) > 256) throw new EmbroideryWriteError("too_many_colors");

  const version = opts.pesVersion ?? 1;
  const needsAscii = format === "dst" || format === "vp3" || (format === "pes" && version === 6);
  const source = needsAscii ? asciiCopy(pattern, format === "dst") : pattern;
  const settings: WriterSettings = format === "pes" ? { ...INKSTITCH_EXPORT_SETTINGS, version } : INKSTITCH_EXPORT_SETTINGS;
  try {
    // Backstop for the estimate: count what the encoder really makes before anything is written.
    if (normalize(source, effectiveSettings(format, settings)).stitches.length > MAX_STITCHES) {
      throw new EmbroideryWriteError("too_large");
    }
    switch (format) {
      case "pes": return writePes(source, settings);
      case "dst": return writeDst(source, settings);
      case "jef": return writeJef(source, settings);
      case "exp": return writeExp(source, settings);
      case "vp3": return writeVp3(source, settings);
    }
  } catch (e) {
    if (e instanceof EmbroideryWriteError) throw e;
    if (e instanceof TooManyColorChangesError) throw new EmbroideryWriteError("too_many_colors");
    throw new EmbroideryWriteError("write_failed");
  }
}

const KNOWN_EXTS = new Set<string>(FORMATS);

/** Replaces a known embroidery extension (any case) with the new one, keeping the rest of the name; else appends. */
export function outputName(filename: string, to: Format): string {
  const ext = fileExtension(filename);
  if (ext !== "" && KNOWN_EXTS.has(ext)) return `${filename.slice(0, filename.length - ext.length)}${to}`;
  return `${filename}.${to}`;
}

export function convert(
  bytes: Uint8Array,
  filename: string,
  to: Format,
  opts?: WriteOptions,
): { bytes: Uint8Array; warnings: Warning[]; outName: string } {
  const pattern = readEmbroidery(bytes, filename);
  // Machines show the design name: a file without one gets its filename stem (ASCII-folded and truncated by the writer).
  let source = pattern;
  const existing = pattern.extras.name;
  if (existing === undefined || existing === null || String(existing).trim() === "") {
    source = pattern.copy();
    const ext = fileExtension(filename);
    const stem = ext !== "" && KNOWN_EXTS.has(ext) ? filename.slice(0, filename.length - ext.length - 1) : filename;
    if (stem !== "") source.extras.name = stem;
  }
  const out = writeEmbroidery(source, to, opts);
  const warnings = conversionWarnings(pattern, to);
  return { bytes: out, warnings, outName: outputName(filename, to) };
}
