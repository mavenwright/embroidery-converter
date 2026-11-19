import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readVp3, writeVp3 } from "../../src/formats/vp3";
import { effectiveSettings } from "../../src/core/settings";
import { normalize } from "../../src/core/encoder";
import { fromJson, loadReference, pythonWrite, toRefShape, withFillerThreads, corpusPath, SYNTHETIC_DIR, DUMP_PY, DUMP_MANY_PY, PARITY_DIR, PYTHON as PY, itPy, describePy, requirePython, type RefDump, type RefRead } from "../helpers/parity";
import { execFileSync } from "node:child_process";
import { describeLocalReadParity } from "../helpers/localParity";

const NAMES = ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"];
const loadJson = (name: string): RefDump => JSON.parse(readFileSync(corpusPath(name, "json"), "utf8")) as RefDump;
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** pystitch's dump of a file made from `bytes`. */
function pythonDump(bytes: Uint8Array): RefDump {
  requirePython();
  const dir = mkdtempSync(join(tmpdir(), "vp3-"));
  try {
    const f = join(dir, "x.vp3");
    writeFileSync(f, bytes);
    return JSON.parse(execFileSync(PY, [DUMP_PY, f]).toString("utf8")) as RefDump;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("VP3 read parity with pystitch", () => {
  for (const name of NAMES) {
    it(`readVp3(${name}.vp3) equals pystitch's dump`, () => {
      const ref = loadReference(name, "vp3");
      expect(toRefShape(readVp3(ref.bytes))).toEqual(ref.dump);
    });
  }
});

describe("VP3 write parity with pystitch", () => {
  for (const name of NAMES) {
    it(`writeVp3(${name}) is byte-identical to pystitch`, () => {
      const ref = loadReference(name, "vp3");
      expect(same(writeVp3(fromJson(loadJson(name))), ref.bytes)).toBe(true);
    });
    it(`readVp3(writeVp3(${name})) equals pystitch's dump of its own file`, () => {
      const ref = loadReference(name, "vp3");
      expect(toRefShape(readVp3(writeVp3(fromJson(loadJson(name)))))).toEqual(ref.dump);
    });
  }

  it("colors120 keeps all 120 colour blocks, byte for byte", () => {
    const ref = loadReference("colors120", "vp3");
    const out = writeVp3(fromJson(loadJson("colors120")));
    expect(same(out, ref.bytes)).toBe(true);
    expect(readVp3(out).threads.length).toBe(120);
  });

  itPy("matches pystitch on 16-bit deltas and long jumps beyond 255 (live oracle)", () => {
    const json = withFillerThreads(loadJson("bigjump"));
    json.stitches.splice(2, 0, [json.stitches[1][0] + 1500, json.stitches[1][1] - 2900, 0]); // STITCH, 16-bit delta
    json.stitches.push([-3000, 4000, 1]); // JUMP, far
    json.stitches.push([-3000, 4000, 0]);
    for (const extra of [undefined, { max_stitch: 100000, max_jump: 100000 }, { encode: false }]) {
      const expected = pythonWrite(json, "vp3", extra);
      const out = writeVp3(fromJson(json), { full_jump: true, trims: true, ...extra });
      expect(same(out, expected), JSON.stringify(extra)).toBe(true);
      expect(toRefShape(readVp3(out))).toEqual(pythonDump(out));
    }
  });

  itPy("matches pystitch for trims, stops and unwritten commands with encode off (live oracle)", () => {
    const json = withFillerThreads(loadJson("trims"));
    const at = json.stitches[3];
    json.stitches.splice(3, 0, [at[0], at[1], 3], [at[0], at[1], 2], [at[0], at[1], 6], [at[0], at[1], 7], [at[0], at[1], 1], [at[0] + 300, at[1], 0x100 | 0]);
    const extra = { encode: false };
    const expected = pythonWrite(json, "vp3", extra);
    const out = writeVp3(fromJson(json), { full_jump: true, trims: true, ...extra });
    expect(same(out, expected)).toBe(true);
    expect(toRefShape(readVp3(out))).toEqual(pythonDump(out));
  });

  itPy("matches pystitch for thread description, catalog number and brand strings (live oracle)", () => {
    const json = withFillerThreads(loadJson("colors3"));
    json.threads[0] = { color: "#123456", description: "Rosa fucsia", catalog_number: "Uber-42", brand: "Brand" };
    json.threads[1] = { color: "#abcdef", description: null, catalog_number: null, brand: null };
    json.threads[2] = { color: "#00ff7f", description: "", catalog_number: "", brand: "x" };
    const expected = pythonWrite(json, "vp3");
    const out = writeVp3(fromJson(json));
    expect(same(out, expected)).toBe(true);
    expect(toRefShape(readVp3(out))).toEqual(pythonDump(out));
  });

  itPy("matches pystitch on non-ASCII strings, including its code-point lengths (live oracle)", () => {
    const json = withFillerThreads(loadJson("colors3"));
    json.threads[0] = { color: "#123456", description: "Rosa \u00e7\u00e3o \u2615", catalog_number: "\u00dcber-42", brand: "Br\u00e4nd" };
    json.threads[2] = { color: "#00ff7f", description: "Astral \u{1d4b3}\u{1f9f5}", catalog_number: "", brand: "x" };
    const expected = pythonWrite(json, "vp3");
    const out = writeVp3(fromJson(json));
    expect(same(out, expected)).toBe(true);
    // pystitch's length fields count code points, so it cannot read such a file back (it raises); the TS throws too.
    expect(() => readVp3(out)).toThrow();
  });

  itPy("pads missing threads with the filler colours exactly as pystitch does when fed them", () => {
    const json = loadJson("colors3");
    json.threads = json.threads.slice(0, 1);
    const expected = pythonWrite(withFillerThreads(json), "vp3");
    const out = writeVp3(fromJson(json));
    expect(same(out, expected)).toBe(true);
    // Also blocks that carry no stitches, which fix_color_count does not cover.
    const noThreads = { ...loadJson("trims"), threads: [] };
    expect(same(writeVp3(fromJson(noThreads)), pythonWrite(withFillerThreads(noThreads), "vp3"))).toBe(true);
  });

  it("does not modify the source pattern, with encode on or off", () => {
    const json = loadJson("colors3");
    json.threads = [];
    for (const settings of [undefined, { encode: false }]) {
      const p = fromJson(json);
      const before = JSON.stringify(toRefShape(p));
      writeVp3(p, settings);
      expect(JSON.stringify(toRefShape(p))).toBe(before);
    }
  });

  it("normalizes with the merged settings before writing (as write_embroidery does)", () => {
    const p = fromJson(loadJson("bigjump"));
    const direct = writeVp3(p);
    const manual = writeVp3(normalize(p, effectiveSettings("vp3", { encode: true, full_jump: true, trims: true })), { encode: false });
    expect(same(direct, manual)).toBe(true);
  });

  it("refuses an empty pattern (pystitch raises on its infinite bounds)", () => {
    const empty = { stitches: [], threads: [{ color: "#ff0000", description: null, catalog_number: null, brand: null }], extras: {} };
    expect(() => writeVp3(fromJson(empty), { encode: false })).toThrow(/empty/);
  });
});

/** pystitch's outcome for every file in `cases`, in one Python process. */
function pythonDumpMany(cases: Map<string, Uint8Array>): Record<string, RefRead | { error: string }> {
  requirePython();
  const dir = mkdtempSync(join(tmpdir(), "vp3many-"));
  try {
    for (const [name, bytes] of cases) writeFileSync(join(dir, name), bytes);
    const out = execFileSync(PY, [DUMP_MANY_PY, dir], { cwd: PARITY_DIR, maxBuffer: 1024 * 1024 * 1024 });
    return JSON.parse(out.toString("utf8")) as Record<string, RefRead | { error: string }>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function outcome(bytes: Uint8Array): RefRead | { error: string } {
  try {
    return toRefShape(readVp3(bytes));
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return { error: "raised" };
  }
}

describePy("VP3 reader on bad input: same outcome as pystitch (live oracle)", () => {
  const compare = (cases: Map<string, Uint8Array>): void => {
    const expected = pythonDumpMany(cases);
    const mismatches: string[] = [];
    for (const [name, bytes] of cases) {
      const e = expected[name];
      const got = outcome(bytes);
      const eRaised = "error" in e;
      const gRaised = "error" in got;
      if (eRaised !== gRaised) mismatches.push(`${name}: pystitch ${eRaised ? "raised" : "returned"}, TS ${gRaised ? "raised" : "returned"}`);
      else if (!eRaised && JSON.stringify(e) !== JSON.stringify(got)) mismatches.push(`${name}: dumps differ`);
    }
    expect(mismatches).toEqual([]);
  };

  for (const name of ["colors3", "trims", "bigjump"]) {
    it(`every truncation of ${name}.vp3 gives pystitch's outcome`, () => {
      const { bytes } = loadReference(name, "vp3");
      const cases = new Map<string, Uint8Array>();
      for (let n = 0; n <= bytes.length; n++) cases.set(`t${n}.vp3`, bytes.subarray(0, n));
      compare(cases);
    });
    it(`deterministic byte flips of ${name}.vp3 give pystitch's outcome`, () => {
      const { bytes } = loadReference(name, "vp3");
      const cases = new Map<string, Uint8Array>();
      let seed = 12345;
      const rnd = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
      for (let k = 0; k < 400; k++) {
        const copy = bytes.slice();
        copy[(rnd() >>> 8) % copy.length] = (rnd() >>> 8) & 0xff;
        if (k % 4 === 0) copy[(rnd() >>> 8) % copy.length] = (rnd() >>> 8) & 0xff;
        cases.set(`f${k}.vp3`, copy);
      }
      compare(cases);
    });
  }

  it("empty, tiny, all-0xff and all-zero inputs give pystitch's outcome", () => {
    const cases = new Map<string, Uint8Array>();
    for (const n of [0, 1, 2, 6, 7, 40, 200]) {
      cases.set(`z${n}.vp3`, new Uint8Array(n));
      cases.set(`f${n}.vp3`, new Uint8Array(n).fill(0xff));
    }
    compare(cases);
  });

  it("a corrupt (negative) colour block length raises like pystitch's ValueError", () => {
    const { bytes } = loadReference("colors3", "vp3");
    // The first colour block's 32-bit length follows its 00 05 00 marker.
    let at = -1;
    for (let i = 0; i + 3 < bytes.length && at < 0; i++) if (bytes[i] === 0 && bytes[i + 1] === 5 && bytes[i + 2] === 0) at = i + 3;
    const bad = bytes.slice();
    bad.set([0xff, 0xff, 0xff, 0x00], at); // distance = -256
    const cases = new Map([["neg.vp3", bad]]);
    expect(pythonDumpMany(cases)["neg.vp3"]).toHaveProperty("error");
    expect(() => readVp3(bad)).toThrow();
  });
});

describeLocalReadParity("VP3", "vp3", (b) => readVp3(b));
