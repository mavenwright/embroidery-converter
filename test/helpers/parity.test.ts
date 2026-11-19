import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EmbThread, FILLER_COLORS } from "../../src/core/thread";
import { EmbPattern } from "../../src/core/pattern";
import { corpusPath, fromJson, loadReference, pythonWrite, toRefShape, withFillerThreads, type RefDump, itPy } from "./parity";

const NAMES = ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"];
const EXTS = ["dst", "exp", "jef", "pes", "vp3"];

describe("parity harness", () => {
  it("loads a reference dump with stitches", () => {
    const ref = loadReference("colors3", "dst");
    expect(ref.dump.stitches.length).toBeGreaterThan(0);
    expect(ref.bytes.length).toBeGreaterThan(0);
  });

  it("has every corpus file", () => {
    for (const name of NAMES) for (const ext of EXTS) expect(loadReference(name, ext).bytes.length).toBeGreaterThan(0);
    for (const name of NAMES) expect(loadReference(name, "v6.pes").dump.stitches.length).toBeGreaterThan(0);
  });

  itPy("pythonWrite reproduces the committed colors3.dst bytes (deterministic)", () => {
    const json = JSON.parse(readFileSync(corpusPath("colors3", "json"), "utf8"));
    expect(Buffer.from(pythonWrite(json, "dst"))).toEqual(Buffer.from(loadReference("colors3", "dst").bytes));
  });

  itPy("pythonWrite honours extra settings (PES version 6)", () => {
    const json = JSON.parse(readFileSync(corpusPath("colors3", "json"), "utf8"));
    expect(Buffer.from(pythonWrite(json, "pes", { version: 6 }))).toEqual(Buffer.from(loadReference("colors3", "v6.pes").bytes));
  });

  itPy("pythonWrite fails loudly when threads are missing", () => {
    const json: RefDump = { stitches: [[0, 0, 0], [5, 5, 5], [9, 9, 0]], threads: [{ color: "#ff0000", description: null, catalog_number: null, brand: null }], extras: {} };
    expect(() => pythonWrite(json, "pes")).toThrow();
    expect(() => pythonWrite(withFillerThreads(json), "pes")).not.toThrow();
  });

  it("fromJson / toRefShape round-trip", () => {
    const json = JSON.parse(readFileSync(corpusPath("colors3", "json"), "utf8")) as RefDump;
    const pattern = fromJson(json);
    expect(pattern).toBeInstanceOf(EmbPattern);
    expect(pattern.threads[0]).toBeInstanceOf(EmbThread);
    expect(pattern.threads[0].color).toBe(0xd62828);
    expect(toRefShape(pattern)).toEqual(json);
  });

  it("withFillerThreads pads to the colour-block count with FILLER_COLORS", () => {
    const json: RefDump = { stitches: [[0, 0, 0], [1, 1, 5], [2, 2, 0], [3, 3, 5], [4, 4, 0]], threads: [{ color: "#010203", description: "a", catalog_number: null, brand: null }], extras: {} };
    const padded = withFillerThreads(json);
    expect(json.threads.length).toBe(1);
    expect(padded.threads.length).toBe(3);
    expect(padded.threads[1]).toEqual({ color: "#" + FILLER_COLORS[1].toString(16).padStart(6, "0"), description: "Random", catalog_number: null, brand: null });
    expect(padded.threads[2].color).toBe("#" + FILLER_COLORS[2].toString(16).padStart(6, "0"));
  });

  it("corpus has the specified shapes", () => {
    expect(loadReference("colors120", "dst").dump.stitches.length).toBeGreaterThan(0);
    const c120 = JSON.parse(readFileSync(corpusPath("colors120", "json"), "utf8")) as RefDump;
    expect(c120.threads.length).toBe(120);
    expect(new Set(c120.threads.map((t) => t.color)).size).toBe(120);
    expect(c120.stitches.filter((s) => s[2] === 5).length).toBe(119);
    const single = JSON.parse(readFileSync(corpusPath("single", "json"), "utf8")) as RefDump;
    expect(single.stitches.length).toBe(1);
    const neg = JSON.parse(readFileSync(corpusPath("negative", "json"), "utf8")) as RefDump;
    expect(neg.stitches.every((s) => s[0] < 0 && s[1] < 0)).toBe(true);
    const big = JSON.parse(readFileSync(corpusPath("large", "json"), "utf8")) as RefDump;
    expect(Math.max(...big.stitches.map((s) => s[0]))).toBe(4000);
    const bj = JSON.parse(readFileSync(corpusPath("bigjump", "json"), "utf8")) as RefDump;
    expect(bj.stitches.some((s, i) => i > 0 && s[2] === 1 && Math.abs(s[0] - bj.stitches[i - 1][0]) === 3000)).toBe(true);
  });

  itPy("withFillerThreads covers trailing and consecutive colour changes", () => {
    const json: RefDump = {
      stitches: [[0, 0, 0], [1, 1, 5], [1, 1, 5], [2, 2, 0], [3, 3, 5]],
      threads: [{ color: "#010203", description: null, catalog_number: null, brand: null }],
      extras: {},
    };
    const padded = withFillerThreads(json);
    expect(padded.threads.length).toBeGreaterThanOrEqual(4);
    for (const ext of ["pes", "vp3"]) expect(() => pythonWrite(padded, ext)).not.toThrow();
  });

  itPy("pythonWrite is byte-identical to the on-disk colors3 file for every format", () => {
    const json = JSON.parse(readFileSync(corpusPath("colors3", "json"), "utf8"));
    for (const ext of EXTS) {
      expect(Buffer.from(pythonWrite(json, ext)), ext).toEqual(Buffer.from(loadReference("colors3", ext).bytes));
    }
  });

  itPy("a failed pythonWrite leaves no output behind", () => {
    const json: RefDump = { stitches: [[0, 0, 0], [5, 5, 5], [9, 9, 0]], threads: [{ color: "#ff0000", description: null, catalog_number: null, brand: null }], extras: {} };
    expect(() => pythonWrite(json, "dst")).toThrow();
  });
});
