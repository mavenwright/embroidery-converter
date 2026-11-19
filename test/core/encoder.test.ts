import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as C from "../../src/core/constants";
import { normalize, Transcoder } from "../../src/core/encoder";
import { encodeThreadChange } from "../../src/core/functions";
import { EmbMatrix } from "../../src/core/matrix";
import { EmbPattern } from "../../src/core/pattern";
import {
  effectiveSettings,
  INKSTITCH_EXPORT_SETTINGS,
  shouldEncode,
  writerDefaults,
  type WriterFormat,
  type WriterSettings,
} from "../../src/core/settings";
import { FILLER_COLORS } from "../../src/core/thread";
import { corpusPath, fromJson, pythonNormalize, toRefShape, type NormalizedRef, type RefDump, describePy } from "../helpers/parity";

const NAMES = ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"];
const FORMATS: WriterFormat[] = ["dst", "exp", "jef", "pes", "vp3"];
const JEF_DATE = "20260101000000";

/** The user settings write.py passes (Ink/Stitch export settings plus the fixed JEF date. */
function exportSettings(fmt: WriterFormat, extra: Record<string, unknown> = {}): WriterSettings {
  return { ...INKSTITCH_EXPORT_SETTINGS, ...(fmt === "jef" ? { date: JEF_DATE } : {}), ...extra } as WriterSettings;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Normalizes with the TS port and checks it against a dump.py --normalized reference. */
function expectParity(json: RefDump, fmt: WriterFormat, ref: NormalizedRef, extra: Record<string, unknown> = {}): void {
  const settings = effectiveSettings(fmt, exportSettings(fmt, extra));
  expect(settings).toEqual(ref.settings);
  const out = toRefShape(normalize(fromJson(json), settings));
  expect(out.stitches).toEqual(ref.stitches);
  expect(out.threads).toEqual(ref.threads);
  expect(out.extras).toEqual(ref.extras);
}

const thread = (color: string, i: number) => ({
  color,
  description: `Thread ${i + 1}`,
  catalog_number: String(100 + i),
  brand: "Parity",
});
const EIGHT_THREADS = ["#d62828", "#1d70b8", "#2a9d3f", "#f4b400", "#7b2cbf", "#00a6a6", "#444444", "#ff8800"].map(thread);

/** Every command branch of transcode_main, with long moves so splitting and contingencies trigger. */
const COMMANDS: RefDump = {
  stitches: [
    [0, 0, C.JUMP],
    [5, 5, C.STITCH],
    [10, 300, C.STITCH],
    [10, 300, C.SLOW],
    [20, 310, C.SEW_TO],
    [400, 310, C.SEW_TO],
    [400, 320, C.NEEDLE_AT],
    [700, 333, C.NEEDLE_AT],
    [700, 333, C.FAST],
    [700, 333, C.TIE_OFF],
    [700, 333, C.TRIM],
    [600, -200, C.JUMP],
    [600, -200, C.STITCH_BREAK],
    [610, -190, C.STITCH],
    [615, -180, C.STITCH],
    [615, -180, C.STOP],
    [620, -170, C.STITCH],
    [620, -170, C.SEQUENCE_BREAK],
    [630, -160, C.STITCH],
    [630, -160, C.COLOR_BREAK],
    [640, -150, C.STITCH],
    [640, -150, C.TIE_ON],
    [640, -150, C.COLOR_CHANGE],
    [650, -140, C.STITCH],
    [650, -140, C.SEQUIN_MODE],
    [660, -130, C.SEQUIN_EJECT],
    [900, -130, C.SEQUIN_EJECT],
    [910, -120, C.STITCH],
    [910, -120, C.FRAME_EJECT],
    [920, -110, C.STITCH],
    [15, -25, C.MATRIX_TRANSLATE],
    [930, -100, C.STITCH],
    [1.5, 0.5, C.MATRIX_SCALE],
    [940, -90, C.STITCH],
    [30, 0, C.MATRIX_ROTATE],
    [950, -80, C.STITCH],
    [1.25, 0.75, C.MATRIX_SCALE_ORIGIN],
    [955, -75, C.STITCH],
    [-12.5, 0, C.MATRIX_ROTATE_ORIGIN],
    [957, -72, C.STITCH],
    [0, 0, C.MATRIX_RESET],
    [960, -70, C.STITCH],
    [0, 0, C.CONTINGENCY_TIE_ON_THREE_SMALL],
    [0, 0, C.CONTINGENCY_TIE_OFF_THREE_SMALL],
    [970, -60, C.STITCH],
    [970, -60, C.TRIM],
    [980, -50, C.STITCH],
    [1290, -40, C.STITCH],
    [990, -40, encodeThreadChange(C.COLOR_CHANGE, 4, 2)],
    [100, 0, C.STITCH],
    [110, 0, C.STITCH],
    [0, 0, C.CONTINGENCY_LONG_STITCH_SEW_TO],
    [500, 0, C.STITCH],
    [0, 0, C.CONTINGENCY_LONG_STITCH_NONE],
    [800, 0, C.STITCH],
    [50, 0, C.OPTION_MAX_STITCH_LENGTH],
    [60, 0, C.OPTION_MAX_JUMP_LENGTH],
    [0, 0, C.OPTION_EXPLICIT_TRIM],
    [0, 0, C.CONTINGENCY_LONG_STITCH_JUMP_NEEDLE],
    [1000, 0, C.STITCH],
    [1000, 0, encodeThreadChange(C.NEEDLE_SET, null, 3)],
    [1000, 200, C.STITCH],
    [0, 0, C.OPTION_IMPLICIT_TRIM],
    [0, 0, C.CONTINGENCY_SEQUIN_UTILIZE],
    [1010, 200, C.SEQUIN_EJECT],
    [0, 0, C.CONTINGENCY_SEQUIN_STITCH],
    [1020, 200, C.SEQUIN_EJECT],
    [0, 0, C.CONTINGENCY_SEQUIN_REMOVE],
    [1030, 200, C.SEQUIN_EJECT],
    [0, 0, C.CONTINGENCY_SEQUIN_JUMP],
    [1040, 200, C.SEQUIN_EJECT],
    [0, 0, C.CONTINGENCY_TIE_ON_NONE],
    [0, 0, C.CONTINGENCY_TIE_OFF_NONE],
    [1050, 200, C.STITCH],
    [1050, 200, C.NO_COMMAND],
    [1060, 210, C.STITCH | C.ALTERNATIVE],
    [1300, 210, C.STITCH | C.ALTERNATIVE],
    [1300, 210, C.END],
    [1, 1, C.STITCH],
  ],
  threads: EIGHT_THREADS,
  extras: { name: "commands" },
};

/** Thread-change sequencing: a change before any stitching, explicit thread/needle/order, SET_CHANGE_SEQUENCE. */
const SEQUENCES: RefDump = {
  stitches: [
    [0, 0, C.COLOR_CHANGE],
    [0, 0, encodeThreadChange(C.SET_CHANGE_SEQUENCE, 5, null, 3)],
    [0, 0, encodeThreadChange(C.SET_CHANGE_SEQUENCE, null, 4)],
    [10, 10, C.STITCH],
    [20, 10, C.STITCH],
    [20, 10, encodeThreadChange(C.COLOR_CHANGE, 6)],
    [30, 30, C.STITCH],
    [30, 30, C.COLOR_BREAK],
    [40, 30, C.STITCH],
    [40, 30, encodeThreadChange(C.NEEDLE_SET, 2, 7)],
    [50, 50, C.STITCH],
    [50, 50, C.COLOR_CHANGE],
    [60, 50, C.STITCH],
    [60, 50, C.COLOR_CHANGE],
    [60, 50, C.COLOR_BREAK],
  ],
  threads: EIGHT_THREADS,
  extras: { name: "sequences" },
};

describe("encoder parity: synthetic corpus × every format", () => {
  for (const name of NAMES) {
    for (const fmt of FORMATS) {
      it(`${name} → ${fmt}`, () => {
        const json = readJson<RefDump>(corpusPath(name, "json"));
        const ref = readJson<NormalizedRef>(corpusPath(name, `${fmt}.normalized.json`));
        expectParity(json, fmt, ref);
      });
    }
  }
});

describePy("encoder parity: live pystitch oracle", () => {
  for (const fmt of FORMATS) {
    it(`every command branch → ${fmt}`, () => {
      expectParity(COMMANDS, fmt, pythonNormalize(COMMANDS, fmt));
    });
    it(`thread-change sequencing → ${fmt}`, () => {
      expectParity(SEQUENCES, fmt, pythonNormalize(SEQUENCES, fmt));
    });
  }

  const VARIANTS: Array<[string, Record<string, unknown>]> = [
    ["tie_on/tie_off true", { tie_on: true, tie_off: true }],
    ["tie_on/tie_off contingency codes", { tie_on: C.CONTINGENCY_TIE_ON_THREE_SMALL, tie_off: C.CONTINGENCY_TIE_OFF_THREE_SMALL }],
    ["explicit_trim", { explicit_trim: true }],
    ["NEEDLE_SET thread change", { thread_change_command: C.NEEDLE_SET, needle_count: 3 }],
    ["NEEDLE_SET with one needle becomes STOP", { thread_change_command: C.NEEDLE_SET, needle_count: 1 }],
    ["STOP thread change", { thread_change_command: C.STOP }],
    ["translate + uniform scale + rotate", { translate: [13, -7], scale: 1.5, rotate: 30 }],
    ["xy scale", { scale: [2, 0.5] }],
    ["writes_speeds false", { writes_speeds: false }],
    ["full_jump false, round false", { full_jump: false, round: false }],
    ["long_stitch_contingency sew_to", { long_stitch_contingency: C.CONTINGENCY_LONG_STITCH_SEW_TO }],
    ["sequins utilized", { sequin_contingency: C.CONTINGENCY_SEQUIN_UTILIZE }],
    ["sequins stitched", { sequin_contingency: C.CONTINGENCY_SEQUIN_STITCH }],
  ];
  for (const [label, extra] of VARIANTS) {
    for (const fmt of ["dst", "vp3"] as WriterFormat[]) {
      it(`${label} (commands → ${fmt})`, () => {
        expectParity(COMMANDS, fmt, pythonNormalize(COMMANDS, fmt, extra), extra);
      });
    }
  }
  for (const name of ["lines", "colors3", "trims"]) {
    it(`${name} with tie_on/tie_off, explicit_trim, rotate (→ jef)`, () => {
      const json = readJson<RefDump>(corpusPath(name, "json"));
      const extra = { tie_on: true, tie_off: true, explicit_trim: true, rotate: 17 };
      expectParity(json, "jef", pythonNormalize(json, "jef", extra), extra);
    });
  }
});

describe("normalize", () => {
  it("does not modify the source pattern", () => {
    const json = readJson<RefDump>(corpusPath("lines", "json"));
    const pattern = fromJson(json);
    normalize(pattern, effectiveSettings("dst", INKSTITCH_EXPORT_SETTINGS));
    expect(toRefShape(pattern)).toEqual(json);
  });

  it("EmbPattern.getNormalizedPattern is normalize", () => {
    const json = readJson<RefDump>(corpusPath("colors3", "json"));
    const settings = effectiveSettings("pes", INKSTITCH_EXPORT_SETTINGS);
    expect(toRefShape(fromJson(json).getNormalizedPattern(settings))).toEqual(toRefShape(normalize(fromJson(json), settings)));
  });

  it("an empty pattern becomes a single END", () => {
    const out = normalize(new EmbPattern(), effectiveSettings("dst", INKSTITCH_EXPORT_SETTINGS));
    expect(out.stitches).toEqual([[0, 0, C.END]]);
    expect(out.threads).toEqual([]);
  });

  it("transcoding a pattern onto itself reads a copy (pystitch semantics)", () => {
    const json = readJson<RefDump>(corpusPath("colors3", "json"));
    const settings = effectiveSettings("exp", INKSTITCH_EXPORT_SETTINGS);
    const pattern = fromJson(json);
    new Transcoder(settings).transcode(pattern, pattern);
    expect(toRefShape(pattern)).toEqual(toRefShape(normalize(fromJson(json), settings)));
  });

  it("missing threads use the deterministic filler", () => {
    const json: RefDump = {
      stitches: [[0, 0, C.STITCH], [9, 9, C.STITCH], [9, 9, C.COLOR_CHANGE], [20, 20, C.STITCH], [20, 20, C.COLOR_CHANGE], [30, 30, C.STITCH]],
      threads: [],
      extras: {},
    };
    const settings = effectiveSettings("pes", INKSTITCH_EXPORT_SETTINGS);
    const a = normalize(fromJson(json), settings);
    const b = normalize(fromJson(json), settings);
    expect(a.threads.map((t) => t.color)).toEqual([FILLER_COLORS[0], FILLER_COLORS[1], FILLER_COLORS[2]]);
    expect(toRefShape(a)).toEqual(toRefShape(b));
  });

  it("raises where pystitch raises instead of hanging", () => {
    const json = readJson<RefDump>(corpusPath("lines", "json"));
    // ZeroDivisionError in interpolate_gap_stitches.
    expect(() => normalize(fromJson(json), { max_stitch: 0, max_jump: 0 })).toThrow(/division by zero/);
    // OverflowError: math.ceil(inf).
    const inf = new EmbPattern();
    inf.addStitchAbsolute(C.STITCH, Infinity, 0);
    expect(() => normalize(inf, { max_jump: 121 })).toThrow(/infinity/);
    // ValueError / OverflowError: round(nan), round(inf).
    const nan = new EmbPattern();
    nan.addStitchAbsolute(C.STITCH, NaN, 0);
    expect(() => normalize(nan, { round: true })).toThrow(/NaN/);
    // ZeroDivisionError: (needle - 1) % 0.
    expect(() => normalize(fromJson(json), { needle_count: 0 })).toThrow(/modulo by zero/);
  });
});

describe("EmbMatrix", () => {
  it("multiplies, translates, scales about a point and inverts like pystitch", () => {
    const m = new EmbMatrix();
    m.postTranslate(10, -4);
    m.postScale(2, 3, 5, 5);
    expect(m.getMatrix()).toEqual([2, 0, 0, 0, 3, 0, 15, -22, 1]);
    expect(m.pointInMatrixSpace(1, 1)).toEqual([17, -19]);
    expect(m.pointInMatrixSpace([1, 1, 7])).toEqual([17, -19, 7]);
    m.inverse();
    // Values from pystitch: [0.5, 0.0, 0.0, 0.0, 0.3333333333333333, 0.0, -7.5, 7.333333333333333, 1.0].
    // Python's int*int products have no signed zero; JS gives -0 there (e.g. 0 * -22). Byte-invisible, so
    // compare with zeros unsigned (v + 0 turns -0 into +0).
    expect(m.getMatrix().map((v) => v + 0)).toEqual([0.5, 0, 0, 0, 0.3333333333333333, 0, -7.5, 7.333333333333333, 1]);
    expect(m.pointInMatrixSpace(17, -19)).toEqual([1, 1]);
    expect(() => new EmbMatrix([0, 0, 0, 0, 0, 0, 0, 0, 1]).inverse()).toThrow(/division by zero/);
  });
});

describe("effectiveSettings (pystitch 1.0.1 write_embroidery merge)", () => {
  it("copies the writer module constants verbatim", () => {
    expect(writerDefaults("dst")).toEqual({
      SEQUIN_CONTINGENCY: C.CONTINGENCY_SEQUIN_UTILIZE,
      FULL_JUMP: false,
      ROUND: true,
      MAX_JUMP_DISTANCE: 121,
      MAX_STITCH_DISTANCE: 121,
    });
    expect(writerDefaults("exp")).toEqual({ SEQUIN_CONTINGENCY: C.CONTINGENCY_SEQUIN_JUMP, FULL_JUMP: true, ROUND: true, MAX_JUMP_DISTANCE: 127, MAX_STITCH_DISTANCE: 127 });
    expect(writerDefaults("jef")).toEqual({ SEQUIN_CONTINGENCY: C.CONTINGENCY_SEQUIN_JUMP, FULL_JUMP: true, ROUND: true, MAX_JUMP_DISTANCE: 127, MAX_STITCH_DISTANCE: 127 });
    expect(writerDefaults("pes")).toEqual({ SEQUIN_CONTINGENCY: C.CONTINGENCY_SEQUIN_JUMP, FULL_JUMP: true, ROUND: true, MAX_JUMP_DISTANCE: 2047, MAX_STITCH_DISTANCE: 2047 });
    expect(writerDefaults("vp3")).toEqual({ SEQUIN_CONTINGENCY: C.CONTINGENCY_SEQUIN_JUMP, FULL_JUMP: false, MAX_JUMP_DISTANCE: 3200, MAX_STITCH_DISTANCE: 255 });
  });

  it("user keys win: full_jump true beats DST's FULL_JUMP false", () => {
    expect(effectiveSettings("dst", { full_jump: true }).full_jump).toBe(true);
    expect(effectiveSettings("pes", { full_jump: false, max_stitch: 50 })).toMatchObject({ full_jump: false, max_stitch: 50, max_jump: 2047 });
  });

  it("fills only missing keys the writer defines", () => {
    expect(effectiveSettings("dst")).toEqual({ max_jump: 121, max_stitch: 121, full_jump: false, round: true, sequin_contingency: C.CONTINGENCY_SEQUIN_UTILIZE });
    // VP3 defines no ROUND, so no "round" key appears.
    expect(effectiveSettings("vp3", INKSTITCH_EXPORT_SETTINGS)).toEqual({
      encode: true,
      full_jump: true,
      trims: true,
      max_jump: 3200,
      max_stitch: 255,
      sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
    });
  });

  it("a key present with null blocks the fill, as a Python None does", () => {
    expect(effectiveSettings("dst", { round: null as unknown as boolean })).toHaveProperty("round", null);
  });

  it("encode false: nothing is filled", () => {
    expect(effectiveSettings("dst", { encode: false, trims: true })).toEqual({ encode: false, trims: true });
    expect(effectiveSettings("pes", { encode: null })).toEqual({ encode: null });
  });

  it("shouldEncode follows settings.get('encode', writer.ENCODE) with Python truthiness", () => {
    expect(shouldEncode("dst", {})).toBe(true);
    expect(shouldEncode("dst", effectiveSettings("dst", INKSTITCH_EXPORT_SETTINGS))).toBe(true);
    expect(shouldEncode("vp3", { encode: false })).toBe(false);
    expect(shouldEncode("vp3", { encode: null })).toBe(false);
  });

  it("does not modify the user's settings object", () => {
    const user: WriterSettings = { full_jump: true };
    effectiveSettings("exp", user);
    expect(user).toEqual({ full_jump: true });
    expect(Object.isFrozen(INKSTITCH_EXPORT_SETTINGS)).toBe(true);
  });
});
