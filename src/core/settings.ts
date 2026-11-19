// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Writer settings: the module constants of DstWriter.py, ExpWriter.py, JefWriter.py, PesWriter.py (PecWriter.py has
// the same values) and Vp3Writer.py, and the settings merge of EmbPattern.write_embroidery (pystitch 1.0.1).
import { CONTINGENCY_SEQUIN_JUMP, CONTINGENCY_SEQUIN_UTILIZE } from "./constants";

export type WriterFormat = "dst" | "exp" | "jef" | "pes" | "vp3";

/**
 * The settings dict pystitch passes to the encoder (EmbEncoder.Transcoder) and the writers. Every key is optional,
 * as in Python, where each reader does `settings.get(key, default)`. A key that is absent (or `undefined`) means
 * "use the default"; `null` is Python's `None`: present, so write_embroidery does not fill it.
 */
export interface WriterSettings {
  // write_embroidery
  /** Normalize through the encoder before writing (default: the writer's ENCODE, True when undefined). */
  encode?: boolean | null;

  // EmbEncoder.Transcoder
  max_stitch?: number | null;
  max_jump?: number | null;
  full_jump?: boolean | null;
  round?: boolean | null;
  needle_count?: number | null;
  thread_change_command?: number | null;
  /** Deprecated in pystitch: use sequin_contingency. */
  strip_sequins?: boolean | null;
  sequin_contingency?: number | null;
  writes_speeds?: boolean | null;
  explicit_trim?: boolean | null;
  /** true means CONTINGENCY_TIE_ON_THREE_SMALL, false CONTINGENCY_TIE_ON_NONE. */
  tie_on?: number | boolean | null;
  /** true means CONTINGENCY_TIE_OFF_THREE_SMALL, false CONTINGENCY_TIE_OFF_NONE. */
  tie_off?: number | boolean | null;
  long_stitch_contingency?: number | null;
  translate?: readonly [number, number] | readonly number[] | null;
  /** A number scales both axes. */
  scale?: number | readonly [number, number] | readonly number[] | null;
  /** Degrees. */
  rotate?: number | null;

  // Writers
  /** JefWriter: write trims. */
  trims?: boolean | null;
  /** DstWriter / JefWriter: jumps that encode a trim. */
  trim_at?: number | null;
  /** JefWriter: "%Y%m%d%H%M%S"; defaults to now in pystitch. */
  date?: string | null;
  /** PesWriter: 1, 6, "1t", "6t" (pystitch default 1). DstWriter: "default" or "extended". */
  version?: number | string | null;
  /** PesWriter: deprecated alias of version. */
  "pes version"?: number | string | null;
  /** PesWriter. */
  truncated?: boolean | null;
  /** DstWriter: deprecated, use version: "extended". */
  "extended header"?: boolean | null;
}

/** A pystitch writer module's constants, as write_embroidery reads them with getattr. Only defined ones are present. */
export interface WriterConstants {
  ENCODE?: boolean;
  MAX_JUMP_DISTANCE?: number;
  MAX_STITCH_DISTANCE?: number;
  FULL_JUMP?: boolean;
  ROUND?: boolean;
  WRITES_SPEEDS?: boolean;
  SEQUIN_CONTINGENCY?: number;
  THREAD_CHANGE_COMMAND?: number;
  EXPLICIT_TRIM?: boolean;
  TRANSLATE?: readonly [number, number];
  SCALE?: number | readonly [number, number];
  ROTATE?: number;
  /** Not merged by write_embroidery in pystitch 1.0.1; listed for completeness. No in-scope writer defines it. */
  LONG_STITCH_CONTINGENCY?: number;
}

// Copied verbatim from the writer modules of pystitch 1.0.1. No in-scope writer defines ENCODE, WRITES_SPEEDS,
// THREAD_CHANGE_COMMAND, EXPLICIT_TRIM, TRANSLATE, SCALE, ROTATE or LONG_STITCH_CONTINGENCY; Vp3Writer defines no ROUND.
const WRITER_CONSTANTS: Readonly<Record<WriterFormat, Readonly<WriterConstants>>> = Object.freeze({
  // DstWriter.py
  dst: Object.freeze({
    SEQUIN_CONTINGENCY: CONTINGENCY_SEQUIN_UTILIZE,
    FULL_JUMP: false,
    ROUND: true,
    MAX_JUMP_DISTANCE: 121,
    MAX_STITCH_DISTANCE: 121,
  }),
  // ExpWriter.py
  exp: Object.freeze({
    SEQUIN_CONTINGENCY: CONTINGENCY_SEQUIN_JUMP,
    FULL_JUMP: true,
    ROUND: true,
    MAX_JUMP_DISTANCE: 127,
    MAX_STITCH_DISTANCE: 127,
  }),
  // JefWriter.py
  jef: Object.freeze({
    SEQUIN_CONTINGENCY: CONTINGENCY_SEQUIN_JUMP,
    FULL_JUMP: true,
    ROUND: true,
    MAX_JUMP_DISTANCE: 127,
    MAX_STITCH_DISTANCE: 127,
  }),
  // PesWriter.py
  pes: Object.freeze({
    SEQUIN_CONTINGENCY: CONTINGENCY_SEQUIN_JUMP,
    FULL_JUMP: true,
    ROUND: true,
    MAX_JUMP_DISTANCE: 2047,
    MAX_STITCH_DISTANCE: 2047,
  }),
  // Vp3Writer.py
  vp3: Object.freeze({
    SEQUIN_CONTINGENCY: CONTINGENCY_SEQUIN_JUMP,
    FULL_JUMP: false,
    // Since jump is stitch, full jump will result in pointless double stitch.
    // Vp3 can encode signed 16 bit deltas.
    MAX_JUMP_DISTANCE: 3200,
    // coded beyond 255 tho, they count as jumps.
    MAX_STITCH_DISTANCE: 255,
  }),
});

/** The writer module constants for `format` (frozen). */
export function writerDefaults(format: WriterFormat): Readonly<WriterConstants> {
  const constants = WRITER_CONSTANTS[format];
  if (constants === undefined) throw new Error(`no writer for format: ${String(format)}`);
  return constants;
}

/** The settings Ink/Stitch exports with. */
export const INKSTITCH_EXPORT_SETTINGS: Readonly<WriterSettings> = Object.freeze({ encode: true, full_jump: true, trims: true });

/** Python truthiness for the values settings carry (None, False, 0, 0.0, "" and empty sequences are false). */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true; // Note: NaN is truthy in Python.
}

/** dict.get(key, default): the value when the key is present (undefined counts as absent), else the default. */
export function settingsGet<K extends keyof WriterSettings, D>(
  settings: WriterSettings,
  key: K,
  defaultValue: D,
): NonNullable<WriterSettings[K]> | null | D {
  const value = settings[key];
  return value === undefined ? defaultValue : (value as NonNullable<WriterSettings[K]> | null);
}

function present(settings: WriterSettings, key: keyof WriterSettings): boolean {
  return Object.prototype.hasOwnProperty.call(settings, key) && settings[key] !== undefined;
}

// [settings key, writer constant], in write_embroidery's order.
const MERGED: ReadonlyArray<[keyof WriterSettings, keyof WriterConstants]> = [
  ["max_jump", "MAX_JUMP_DISTANCE"],
  ["max_stitch", "MAX_STITCH_DISTANCE"],
  ["full_jump", "FULL_JUMP"],
  ["round", "ROUND"],
  ["writes_speeds", "WRITES_SPEEDS"],
  ["sequin_contingency", "SEQUIN_CONTINGENCY"],
  ["thread_change_command", "THREAD_CHANGE_COMMAND"],
  ["explicit_trim", "EXPLICIT_TRIM"],
  ["translate", "TRANSLATE"],
  ["scale", "SCALE"],
  ["rotate", "ROTATE"],
];

/**
 * Port of the settings merge in pystitch 1.0.1 EmbPattern.write_embroidery: copy the user's settings; `encode`
 * defaults to the writer's ENCODE (True if it has none); only when encode is truthy, every key above that is not
 * already present is filled from the writer constant, if the writer defines one. User keys win. The result is what
 * write_embroidery passes to get_normalized_pattern (when encode is truthy) and to the writer.
 */
export function effectiveSettings(format: WriterFormat, user?: WriterSettings | null): WriterSettings {
  const writer = writerDefaults(format);
  const settings: WriterSettings = {};
  if (user != null) {
    for (const key of Object.keys(user) as Array<keyof WriterSettings>) {
      if (user[key] !== undefined) (settings as Record<string, unknown>)[key] = user[key];
    }
  }
  const encode = writer.ENCODE ?? true;
  if (pyTruthy(settingsGet(settings, "encode", encode))) {
    for (const [key, constant] of MERGED) {
      if (!present(settings, key) && writer[constant] !== undefined) {
        (settings as Record<string, unknown>)[key] = writer[constant];
      }
    }
  }
  return settings;
}

/** True when write_embroidery would normalize through the encoder for these (already merged) settings. */
export function shouldEncode(format: WriterFormat, settings: WriterSettings): boolean {
  return pyTruthy(settingsGet(settings, "encode", writerDefaults(format).ENCODE ?? true));
}
