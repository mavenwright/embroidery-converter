// Format detection from magic bytes, content checks and file names. Magic bytes win over the extension, and for
// formats without a magic (DST without header, EXP, JEF) the content must validate: an extension is never enough.
import { dstBodyLooksValid, jefHeaderUsable, jefHeaderValid, jefStitchWalk, scanExp } from "./integrity";

export type Format = "pes" | "dst" | "jef" | "exp" | "vp3";

export const FORMATS: readonly Format[] = ["pes", "dst", "jef", "exp", "vp3"];

/** The lower-case extension of a file name (no dot), or "" when there is none. Case-insensitive matching starts here. */
export function fileExtension(filename: string | undefined): string {
  if (!filename) return "";
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, ascii: string, at = 0): boolean {
  if (bytes.length < at + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

function startsWithBytes(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

const u32le = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** A real BMP: "BM", the size field equals the file size, reserved is 0, and a known DIB header size follows. */
function isBmp(b: Uint8Array): boolean {
  return b.length >= 18 && startsWith(b, "BM") && u32le(b, 2) === b.length && u32le(b, 6) === 0 &&
    [12, 40, 52, 56, 64, 108, 124].includes(u32le(b, 14));
}

/** Common non-embroidery files, by signature. readDst/readExp would "succeed" on these. */
function isKnownForeignFile(b: Uint8Array): boolean {
  return (
    startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWithBytes(b, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(b, "GIF8") ||
    startsWith(b, "%PDF") ||
    startsWithBytes(b, [0x50, 0x4b, 0x03, 0x04]) || // ZIP (also docx, xlsx)
    startsWithBytes(b, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(b, [0x1f, 0x8b]) || // gzip
    startsWithBytes(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || // 7z
    startsWithBytes(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) || // RAR
    startsWithBytes(b, [0x49, 0x49, 0x2a, 0x00]) || // TIFF little endian
    startsWithBytes(b, [0x4d, 0x4d, 0x00, 0x2a]) || // TIFF big endian
    startsWithBytes(b, [0x00, 0x00, 0x01, 0x00]) || // ICO
    startsWith(b, "ftyp", 4) || // HEIC, AVIF, MP4, MOV
    (startsWith(b, "RIFF") && startsWith(b, "WEBP", 8)) ||
    startsWith(b, "RIFF") || // WAV, AVI
    startsWith(b, "OggS") ||
    startsWith(b, "ID3") ||
    isBmp(b)
  );
}

/** Plain text: valid UTF-8 (BOM or not), or UTF-16 with a BOM, with no control characters other than whitespace. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, 4096);
  const noControls = (s: string): boolean => !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(s);
  if (startsWithBytes(sample, [0xff, 0xfe]) || startsWithBytes(sample, [0xfe, 0xff])) {
    try {
      return noControls(new TextDecoder(sample[0] === 0xff ? "utf-16le" : "utf-16be", { fatal: true }).decode(sample.subarray(2, sample.length & ~1)));
    } catch {
      return false;
    }
  }
  // A 4096-byte cut may split a multi-byte character: drop up to 3 trailing bytes when the full file is longer.
  for (let cut = 0; cut <= (bytes.length > 4096 ? 3 : 0); cut++) {
    try {
      return noControls(new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - cut)));
    } catch {
      /* try a shorter cut */
    }
  }
  return false;
}

/**
 * EXP has no magic: accept only a body that follows ExpReader's grammar (a final partial record is allowed, so a
 * truncated file is reported as corrupt rather than unknown). No step-size rule: satin and long stitches are valid.
 * Tiny random files that happen to follow the grammar may still pass; that residual is accepted.
 */
function looksLikeExp(b: Uint8Array): boolean {
  const scan = scanExp(b);
  return scan.grammarOk && scan.stitches > 0;
}

/**
 * Detects the format, or null when the bytes are not a recognisable embroidery file.
 * 1. Magic: "#PES"/"#PEC" is pes, "%vsm%" is vp3, "LA:" is dst (all win over the extension).
 * 2. JEF by content: the header offset equals 0x74 + 8 * colour count (JefWriter). Named .jef, a header JefReader
 *    can still follow (jefHeaderUsable) over data made of JEF records is a JEF too; if that data stops short of the
 *    end record, the integrity check calls it corrupt.
 * 3. Otherwise the extension (case-insensitive) must be paired with valid content; common non-embroidery files and
 *    text give null. A file that is only a cut-off start of a magic (or a JEF under 28 bytes) keeps its extension's format so
 *    the reader can call it corrupt.
 */
export function detectFormat(bytes: Uint8Array, filename?: string): Format | null {
  if (startsWith(bytes, "#PES") || startsWith(bytes, "#PEC")) return "pes";
  if (startsWith(bytes, "%vsm%")) return "vp3";
  if (startsWith(bytes, "LA:")) return "dst";
  if (bytes.length === 0) return null;
  if (jefHeaderValid(bytes) && !isKnownForeignFile(bytes)) return "jef";
  const ext = fileExtension(filename);
  if (!(FORMATS as readonly string[]).includes(ext)) return null;
  const prefixOf = (magic: string): boolean => bytes.length < magic.length && magic.startsWith(String.fromCharCode(...bytes));
  if ((ext === "pes" && prefixOf("#PES")) || (ext === "vp3" && prefixOf("%vsm%")) || (ext === "dst" && prefixOf("LA:"))) {
    return ext as Format;
  }
  if (isKnownForeignFile(bytes) || looksLikeText(bytes)) return null;
  switch (ext as Format) {
    case "pes":
    case "vp3": return null;
    // A header that fails JefWriter's formula is still a JEF when JefReader can follow it and its stitch data is JEF
    // records; if that data runs out before the end record, the integrity check calls it corrupt (a cut-off download).
    case "jef": return bytes.length < 28 || (jefHeaderUsable(bytes) && jefStitchWalk(bytes) !== "invalid") ? "jef" : null;
    case "dst": return bytes.length >= 515 && dstBodyLooksValid(bytes) ? "dst" : null;
    case "exp": return looksLikeExp(bytes) ? "exp" : null;
  }
}
