// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of ExpReader.py and ExpWriter.py (pystitch 1.0.1). Units are 0.1 mm.
//
// pystitch -> TS: read_exp_stitches/read -> readExp; write (+ write_embroidery's merge and normalize) -> writeExp.
import { COLOR_CHANGE, COMMAND_MASK, JUMP, STITCH, STOP, TRIM } from "../core/constants";
import { normalize } from "../core/encoder";
import { EmbPattern } from "../core/pattern";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings, shouldEncode, type WriterSettings } from "../core/settings";
import { pyRound } from "../core/thread";
import { ByteReader, signed8 } from "../io/reader";
import { ByteWriter } from "../io/writer";

/** API safety limit (not in pystitch), shared by the readers without other settings. */
export interface ReadLimitOptions {
  maxStitches?: number | null;
}

/** ExpReader.read_exp_stitches. Stops on a short read or an unknown control record, then ends the pattern. */
export function readExp(bytes: Uint8Array | ArrayBuffer, opts: ReadLimitOptions | null = {}): EmbPattern {
  const f = new ByteReader(bytes);
  const out = new EmbPattern();
  out.maxStitches = opts?.maxStitches ?? null;
  for (;;) {
    let b = f.read(2);
    if (b.length !== 2) break;
    if (b[0] !== 0x80) {
      out.stitch(signed8(b[0]), 0 - signed8(b[1])); // 0 - v: Python's -0 is 0.
      continue;
    }
    const control = b[1];
    b = f.read(2); // 07 00
    if (b.length !== 2) break;
    const x = signed8(b[0]);
    const y = 0 - signed8(b[1]);
    if (control === 0x80) {
      out.trim(); // Trim
    } else if (control === 0x02) {
      out.stitch(x, y); // This shouldn't exist.
    } else if (control === 0x04) {
      out.move(x, y); // Jump
    } else if (control === 0x01) {
      out.colorChange(); // Colorchange
      if (x !== 0 || y !== 0) out.move(x, y);
    } else {
      break; // Uncaught control
    }
  }
  out.end();
  return out;
}

/** The ported ExpWriter.write: writes `pattern` as is (no normalizing). */
function writeRaw(pattern: EmbPattern, f: ByteWriter): void {
  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const data = stitch[2] & COMMAND_MASK;
    const dx = pyRound(stitch[0] - xx);
    const dy = pyRound(stitch[1] - yy);
    xx += dx;
    yy += dy;
    if (data === STITCH) {
      f.write(Uint8Array.of(dx & 0xff, -dy & 0xff));
    } else if (data === JUMP) {
      f.write(Uint8Array.of(0x80, 0x04, dx & 0xff, -dy & 0xff));
    } else if (data === TRIM) {
      f.write(Uint8Array.of(0x80, 0x80, 0x07, 0x00));
    } else if (data === COLOR_CHANGE || data === STOP) {
      f.write(Uint8Array.of(0x80, 0x01, 0x00, 0x00));
    }
    // END (and anything else) writes nothing.
  }
}

/**
 * write_embroidery for EXP: merge `settings` with ExpWriter's constants, normalize through the encoder when encode
 * is on, then write. The source pattern is not modified.
 */
export function writeExp(pattern: EmbPattern, settings: WriterSettings = INKSTITCH_EXPORT_SETTINGS): Uint8Array {
  const merged = effectiveSettings("exp", settings);
  const source = shouldEncode("exp", merged) ? normalize(pattern, merged) : pattern;
  const out = new ByteWriter(4096);
  writeRaw(source, out);
  return out.toUint8Array();
}
