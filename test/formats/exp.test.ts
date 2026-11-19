import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readExp, writeExp } from "../../src/formats/exp";
import { effectiveSettings } from "../../src/core/settings";
import { normalize } from "../../src/core/encoder";
import { fromJson, loadReference, pythonWrite, toRefShape, withFillerThreads, corpusPath, SYNTHETIC_DIR, DUMP_PY, PYTHON as PY, type RefDump, itPy } from "../helpers/parity";
import { execFileSync } from "node:child_process";
import { describeLocalReadParity } from "../helpers/localParity";

const NAMES = ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"];
const loadJson = (name: string): RefDump => JSON.parse(readFileSync(corpusPath(name, "json"), "utf8")) as RefDump;

describe("EXP read parity with pystitch", () => {
  for (const name of NAMES) {
    it(`readExp(${name}.exp) equals pystitch's dump`, () => {
      const ref = loadReference(name, "exp");
      expect(toRefShape(readExp(ref.bytes))).toEqual(ref.dump);
    });
  }

  itPy("matches pystitch on every control record, including the odd ones (live oracle)", () => {
    const bytes = Uint8Array.of(
      5, 250, //          stitch
      0x80, 0x02, 3, 4, // control 02: stitch
      0x80, 0x04, 0xfb, 7, // jump
      0x80, 0x01, 0, 0, // colour change, no move
      0x80, 0x01, 9, 0xf0, // colour change with move
      0x80, 0x80, 7, 0, // trim
      1, 2,
      0x80, 0x33, 1, 1, // uncaught control: stops reading
      9, 9,
    );
    const dir = mkdtempSync(join(tmpdir(), "exp-"));
    try {
      const f = join(dir, "odd.exp");
      writeFileSync(f, bytes);
      const expected = JSON.parse(execFileSync(PY, [DUMP_PY, f]).toString("utf8")) as RefDump;
      expect(toRefShape(readExp(bytes))).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EXP write parity with pystitch", () => {
  for (const name of NAMES) {
    it(`writeExp(${name}) is byte-identical to pystitch`, () => {
      const ref = loadReference(name, "exp");
      const out = writeExp(fromJson(loadJson(name)));
      expect(Buffer.from(out).equals(Buffer.from(ref.bytes))).toBe(true);
    });
    it(`readExp(writeExp(${name})) equals pystitch's dump of its own file`, () => {
      const ref = loadReference(name, "exp");
      expect(toRefShape(readExp(writeExp(fromJson(loadJson(name)))))).toEqual(ref.dump);
    });
  }

  itPy("matches pystitch for STOP commands (live oracle)", () => {
    const json = withFillerThreads(loadJson("colors3"));
    json.stitches.splice(3, 0, [json.stitches[2][0], json.stitches[2][1], 3]); // STOP
    const expected = pythonWrite(json, "exp");
    const out = writeExp(fromJson(json));
    expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
  });

  itPy("matches pystitch with encode off (raw TRIM/JUMP/STOP, live oracle)", () => {
    const json = withFillerThreads(loadJson("trims"));
    const extra = { encode: false };
    const expected = pythonWrite(json, "exp", extra);
    const out = writeExp(fromJson(json), { full_jump: true, trims: true, ...extra });
    expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
  });

  it("normalizes with the merged settings before writing (as write_embroidery does)", () => {
    const p = fromJson(loadJson("bigjump"));
    const direct = writeExp(p);
    const manual = writeExp(normalize(p, effectiveSettings("exp", { encode: true, full_jump: true, trims: true })), { encode: false });
    expect(Buffer.from(direct).equals(Buffer.from(manual))).toBe(true);
  });
});

describe("EXP reader on bad input", () => {
  it("reads a truncated file without throwing or hanging", () => {
    const ref = loadReference("lines", "exp");
    const p = readExp(ref.bytes.subarray(0, 7));
    expect(p.stitches.length).toBeGreaterThan(0);
    expect(() => readExp(ref.bytes.subarray(0, ref.bytes.length - 1))).not.toThrow();
  });
  it("reads empty and tiny input", () => {
    expect(() => readExp(new Uint8Array(0))).not.toThrow();
    expect(() => readExp(new Uint8Array(1))).not.toThrow();
    expect(() => readExp(Uint8Array.of(0x80, 0x01, 0))).not.toThrow();
  });
});

describeLocalReadParity("EXP", "exp", (b) => readExp(b));
