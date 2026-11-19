// Structural integrity checks the API runs after a read. The readers mirror pystitch and quietly return a partial
// design when a file is cut off; every writer pystitch has always produces the markers checked here, so a file
// missing one of them is truncated or broken. All checks are cheap (no decoding).
import type { Format } from "./detect";

const u32le = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u24le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

export const DST_HEADER = 512;

// "Complete" means the stitch data is all there: the reader reaches the format's end marker (or declared end) at or
// before EOF, and every length or offset the reader follows to get there is inside the file. Bytes after a valid end
// are allowed: other writers append padding. Header fields the reader does not use (a JEF header offset formula,
// a PEC stitch-block length that disagrees with the stitch data, missing PEC thumbnails, a zeroed VP3 outer block
// length) do not make a file corrupt on their own; a file cut inside its stitch data still is.

/** DstReader: an END record (byte 3 matches 0xF3) sits at a record boundary after the 512-byte header. */
export function dstIntact(b: Uint8Array): boolean {
  for (let i = DST_HEADER; i + 3 <= b.length; i += 3) if ((b[i + 2] & 0xf3) === 0xf3) return true;
  return false;
}

/** Most bytes allowed after a DST's END record when the body is judged by content (writers append small padding). */
export const DST_MAX_TAIL = 512;
/** Records (END included) a content-judged DST needs before bytes after its END are accepted. */
export const DST_MIN_RECORDS_WITH_TAIL = 8;

/**
 * For a DST without the "LA:" header: DstWriter.encode_record always sets bits 0 and 1 of the third byte, so every
 * record up to the first END must have them. Bytes after the END are padding some writers add (0x1A, A1 00 00, zeros)
 * and are not checked, as long as there are at most DST_MAX_TAIL of them and the END is at least the
 * DST_MIN_RECORDS_WITH_TAIL-th record: otherwise a random file whose first few records happen to look valid, followed
 * by something that looks like an END, would pass. Without an END, every whole record must look valid (a cut-off file,
 * which the integrity check then calls corrupt).
 */
export function dstBodyLooksValid(b: Uint8Array): boolean {
  if (b.length < DST_HEADER + 3) return false;
  const n = Math.floor((b.length - DST_HEADER) / 3);
  for (let i = 0; i < n; i++) {
    const c = b[DST_HEADER + i * 3 + 2];
    if ((c & 3) !== 3) return false;
    if ((c & 0xf3) === 0xf3) {
      const tail = b.length - (DST_HEADER + i * 3 + 3);
      return tail === 0 || (tail <= DST_MAX_TAIL && i + 1 >= DST_MIN_RECORDS_WITH_TAIL);
    }
  }
  return true;
}

/** JefWriter: stitch data starts at 0x74 + 8 * colour count (int32 at 0 and at 24). */
export function jefHeaderValid(b: Uint8Array): boolean {
  if (b.length < 28) return false;
  const count = u32le(b, 24);
  return count <= 0x1000000 && u32le(b, 0) === 0x74 + 8 * count;
}

/** The colour count the JEF header claims. */
export function jefColorCount(b: Uint8Array): number {
  return b.length >= 28 ? u32le(b, 24) : 0;
}

/** Most colours a JEF header may claim when it fails JefWriter's formula (the API's own limit for any JEF is 5000). */
export const JEF_LOOSE_MAX_COLORS = 5000;

/**
 * A JEF header the reader can follow even when JefWriter's offset formula fails: the colour indices JefReader reads
 * from 0x74 lie before the stitch offset, and the offset is no further than a full header (with the per-colour type
 * table, 0x74 + 8 * count) plus 512 bytes. Some writers leave out the type table (offset 0x74 + 4 * count). The
 * bounds keep foreign files, whose first bytes are seldom that consistent, from passing for a JEF.
 */
export function jefHeaderUsable(b: Uint8Array): boolean {
  if (b.length < 28) return false;
  const count = u32le(b, 24);
  const offset = u32le(b, 0);
  return count <= JEF_LOOSE_MAX_COLORS && offset >= 0x74 + 4 * count && offset <= 0x74 + 8 * count + 512;
}

/**
 * JefReader's stitch walk from the header offset: "end" when it reaches the 0x80 0x10 end record at a record boundary,
 * "ranout" when the data stops first (a cut file, including an offset past the end), "invalid" when it meets a
 * control code JefReader does not know (not JEF stitch data).
 */
export function jefStitchWalk(b: Uint8Array): "end" | "ranout" | "invalid" {
  const offset = u32le(b, 0);
  if (offset > b.length) return "ranout";
  let i = offset;
  while (i + 2 <= b.length) {
    if (b[i] !== 0x80) {
      i += 2;
      continue;
    }
    const ctrl = b[i + 1];
    if (ctrl === 0x10) return "end";
    if (ctrl !== 0x01 && ctrl !== 0x02) return "invalid";
    if (i + 4 > b.length) return "ranout";
    i += 4;
  }
  return "ranout";
}

/** JefReader: a header it can follow (JefWriter's, or a usable one) and stitch data that reaches its end record. */
export function jefIntact(b: Uint8Array): boolean {
  return (jefHeaderValid(b) || jefHeaderUsable(b)) && jefStitchWalk(b) === "end";
}



export interface ExpScan {
  /** The whole file parsed as EXP records up to a final partial record at most. */
  grammarOk: boolean;
  /** Parsed cleanly to the exact end of the file. */
  complete: boolean;
  stitches: number;
}

/** Walks ExpReader's grammar: 2-byte stitches, and 4-byte 0x80-control records (80, 02, 04 or 01). */
export function scanExp(b: Uint8Array): ExpScan {
  let i = 0;
  let stitches = 0;
    while (i + 2 <= b.length) {
    if (b[i] !== 0x80) {
      stitches++;
      i += 2;
      continue;
    }
    const c = b[i + 1];
    if (c !== 0x80 && c !== 0x02 && c !== 0x04 && c !== 0x01) return { grammarOk: false, complete: false, stitches };
    if (i + 4 > b.length) return { grammarOk: true, complete: false, stitches };
    i += 4;
  }
  return { grammarOk: true, complete: i === b.length, stitches };
}

export function expIntact(b: Uint8Array): boolean {
  return scanExp(b).complete;
}

/**
 * read_pec_stitches' walk: the index of the 0xFF that ends the stitch data, or -1 when the data runs out first. The
 * 0xFF must be followed by 0x00, or be the last byte of the file (pystitch stops there too).
 */
function pecStitchEnd(b: Uint8Array, start: number): number {
  let i = start;
  for (;;) {
    if (i === b.length - 1 && b[i] === 0xff) return i;
    if (i + 2 > b.length) return -1;
    const v1 = b[i];
    let v2 = b[i + 1];
    i += 2;
    if (v1 === 0xff && v2 === 0x00) return i - 2;
    if (v1 === 0xfe && v2 === 0xb0) {
      i += 1;
      continue;
    }
    if (v1 & 0x80) {
      if (i >= b.length) return -1;
      v2 = b[i++];
    }
    if (v2 & 0x80) {
      if (i >= b.length) return -1;
      i += 1;
    }
  }
}

/**
 * PesReader: the PEC header and the stitch data (to its 0xFF end) lie inside the file.
 *
 * Thumbnails: in every PES we have checked whose thumbnails are present (pystitch's, Wilcom's and those of one other
 * program), the PEC stitch-block length ends right after that 0xFF, with the thumbnails following. When the length agrees with the stitch data, the
 * thumbnails it announces must be there too: a file cut inside them is truncated. When it disagrees (an old writer
 * got it wrong, and such files often carry no thumbnails at all), the length is not trusted and complete stitch data
 * is enough. Neither field is used to read the stitches.
 */
export function pesIntact(b: Uint8Array): boolean {
  let pec = 8;
  if (b.length < 12) return false;
  const bare = b[0] === 0x23 && b[1] === 0x50 && b[2] === 0x45 && b[3] === 0x43 && b[4] === 0x30 && b[5] === 0x30 && b[6] === 0x30 && b[7] === 0x31;
  if (!bare) {
    pec = u32le(b, 8);
    if (pec < 12 || pec + 0x206 > b.length) return false;
  } else if (b.length < pec + 0x206) {
    return false;
  }
  const stride = b[pec + 34];
  const height = b[pec + 35];
  const colorChanges = b[pec + 48];
  const lenAt = pec + 3 + 16 + 0xf + 2 + 0xc + 1 + (colorChanges + 1) + (0x1d0 - colorChanges);
  if (lenAt + 3 > b.length) return false;
  const end = pecStitchEnd(b, lenAt + 3 + 15);
  if (end < 0) return false;
  const stitchBlockEnd = u24le(b, lenAt) - 5 + (lenAt + 3);
  if (stitchBlockEnd !== end + 1) return true;
  return stitchBlockEnd + (colorChanges + 2) * stride * height <= b.length;
}

/** Vp3Reader: the header and every colour block it walks lie inside the file (trailing bytes are tolerated). */
export function vp3Intact(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  const p = 8 + ((b[6] << 8) | b[7]);
  if (p + 7 > b.length) return false;
  // The outer block's 7 bytes (00 02 00 and a length) are skipped by the reader, so they are not checked:
  // some writers leave them zero, and a wrong length must neither excuse a cut file nor condemn a complete one.
  return vp3BlocksIntact(b, p + 7);
}

/**
 * Vp3Reader's walk from just after the outer block header: the header strings and fields, the colour count, then each
 * colour block (00 05 00, its length, and the bytes up to its end, where the next one starts) must lie in the file.
 */
function vp3BlocksIntact(b: Uint8Array, start: number): boolean {
  let pos = start;
  const skipString = (): boolean => {
    if (pos + 2 > b.length) return false;
    pos += 2 + ((b[pos] << 8) | b[pos + 1]);
    return pos <= b.length;
  };
  if (!skipString()) return false; // comments and note
  pos += 32 + 8 + 27; // fields, the design centre, fields
  if (!skipString()) return false;
  pos += 24;
  if (!skipString()) return false;
  if (pos + 2 > b.length) return false;
  const count = (b[pos] << 8) | b[pos + 1];
  pos += 2;
  if (count === 0) return false;
  for (let i = 0; i < count; i++) {
    if (pos + 7 > b.length) return false;
    if (b[pos] !== 0 || b[pos + 1] !== 5 || b[pos + 2] !== 0) return false;
    const end = pos + 7 + u32be(b, pos + 3);
    if (end > b.length) return false;
    pos = end;
  }
  return true;
}

export function isIntact(format: Format, b: Uint8Array): boolean {
  switch (format) {
    case "dst": return dstIntact(b);
    case "jef": return jefIntact(b);
    case "exp": return expIntact(b);
    case "pes": return pesIntact(b);
    case "vp3": return vp3Intact(b);
  }
}
