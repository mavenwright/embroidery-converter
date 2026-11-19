import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readDst, writeDst } from "../../src/formats/dst";
import { effectiveSettings } from "../../src/core/settings";
import { normalize } from "../../src/core/encoder";
import { fromJson, loadReference, pythonWrite, toRefShape, withFillerThreads, corpusPath, SYNTHETIC_DIR, type RefDump, itPy } from "../helpers/parity";
import { execFileSync } from "node:child_process";
import { describeLocalReadParity } from "../helpers/localParity";

const NAMES = ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"];
const loadJson = (name: string): RefDump => JSON.parse(readFileSync(corpusPath(name, "json"), "utf8")) as RefDump;

describe("DST read parity with pystitch", () => {
  for (const name of NAMES) {
    it(`readDst(${name}.dst) equals pystitch's dump`, () => {
      const ref = loadReference(name, "dst");
      expect(toRefShape(readDst(ref.bytes))).toEqual(ref.dump);
    });
  }
});

describe("DST write parity with pystitch", () => {
  for (const name of NAMES) {
    it(`writeDst(${name}) is byte-identical to pystitch`, () => {
      const ref = loadReference(name, "dst");
      const out = writeDst(fromJson(loadJson(name)));
      expect(Buffer.from(out).equals(Buffer.from(ref.bytes))).toBe(true);
    });
    it(`readDst(writeDst(${name})) equals pystitch's dump of its own file`, () => {
      const ref = loadReference(name, "dst");
      expect(toRefShape(readDst(writeDst(fromJson(loadJson(name)))))).toEqual(ref.dump);
    });
  }

  itPy("matches pystitch with the extended header and trim_at=5 (live oracle)", () => {
    const json = withFillerThreads(loadJson("trims"));
    const extra = { version: "extended", trim_at: 5 };
    const expected = pythonWrite(json, "dst", extra);
    const out = writeDst(fromJson(json), { encode: true, full_jump: true, trims: true, ...extra });
    expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
  });

  itPy("matches pystitch for the deprecated 'extended header' setting", () => {
    const json = withFillerThreads(loadJson("colors3"));
    const extra = { "extended header": true };
    const expected = pythonWrite(json, "dst", extra);
    const out = writeDst(fromJson(json), { encode: true, full_jump: true, trims: true, ...extra });
    expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
  });

  it("normalizes with the merged settings before writing (as write_embroidery does)", () => {
    const p = fromJson(loadJson("bigjump"));
    const direct = writeDst(p);
    const manual = writeDst(normalize(p, effectiveSettings("dst", { encode: true, full_jump: true, trims: true })), { encode: false });
    expect(Buffer.from(direct).equals(Buffer.from(manual))).toBe(true);
  });
});

describe("DST reader on bad input", () => {
  it("reads the header plus a partial record without throwing or hanging", () => {
    const ref = loadReference("lines", "dst");
    const p = readDst(ref.bytes.subarray(0, 512 + 7));
    expect(p.stitches.length).toBeGreaterThan(0);
    expect(p.extras["name"]).toBe("lines");
  });
  it("reads empty and tiny input as an empty-ish pattern", () => {
    expect(() => readDst(new Uint8Array(0))).not.toThrow();
    expect(() => readDst(new Uint8Array(3))).not.toThrow();
  });
});

describeLocalReadParity("DST", "dst", (b) => readDst(b));
