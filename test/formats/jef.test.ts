import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getJefHoopSize, readJef, writeJef } from "../../src/formats/jef";
import { getThreadSet } from "../../src/threads/jef";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings } from "../../src/core/settings";
import { normalize } from "../../src/core/encoder";
import { EmbPattern } from "../../src/core/pattern";
import { COLOR_CHANGE, END, STITCH, STOP } from "../../src/core/constants";
import {
  fromJson, loadReference, pythonRead as pythonReadFile, pythonWrite, toRefShape, withFillerThreads, corpusPath, SYNTHETIC_DIR, PARITY_DIR, PYTHON as PY, itPy, requirePython,
  type RefDump, type RefRead,
} from "../helpers/parity";
import { FILLER_COLORS, isPlaceholder } from "../../src/core/thread";
import { writePes, readPes } from "../../src/formats/pes";
import { writeDst } from "../../src/formats/dst";
import { writeExp } from "../../src/formats/exp";
import { writeVp3 } from "../../src/formats/vp3";
import { convert, readEmbroidery } from "../../src/api";
import { conversionWarnings } from "../../src/warnings";
import { computeStats } from "../../src/stats";
import { describeLocalReadParity } from "../helpers/localParity";

const NAMES = ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"];
const DATE = "20260101000000";
const SETTINGS = { ...INKSTITCH_EXPORT_SETTINGS, date: DATE };
const loadJson = (name: string): RefDump => JSON.parse(readFileSync(corpusPath(name, "json"), "utf8")) as RefDump;
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** pystitch.read of `bytes` as a .jef with the given reader settings, in the parity dump shape. */
function pythonRead(bytes: Uint8Array, settings: Record<string, unknown> | null): RefDump {
  requirePython();
  const dir = mkdtempSync(join(tmpdir(), "jef-"));
  try {
    const f = join(dir, "in.jef");
    writeFileSync(f, bytes);
    const code = [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(PARITY_DIR)})`,
      "from dump import dump_pattern",
      "from pystitch import JefReader",
      "from pystitch import EmbPattern",
      "p = EmbPattern()",
      "s = json.loads(sys.argv[2])",
      "JefReader.read(open(sys.argv[1], 'rb'), p, s)",
      "print(json.dumps(dump_pattern(p)))",
    ].join("\n");
    return JSON.parse(execFileSync(PY, ["-c", code, f, JSON.stringify(settings)], { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8")) as RefDump;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pythonThrowsOnRead(bytes: Uint8Array): boolean {
  requirePython();
  try {
    pythonRead(bytes, null);
    return false;
  } catch {
    return true;
  }
}

/** A small JEF file by hand: `colors` palette entries, then raw stitch bytes. */
function handJef(colors: number[], stitchBytes: number[]): Uint8Array {
  const header = new Uint8Array(0x74 + colors.length * 8);
  const dv = new DataView(header.buffer);
  dv.setInt32(0, header.length, true);
  dv.setInt32(24, colors.length, true);
  colors.forEach((c, i) => dv.setInt32(0x74 + i * 4, c, true));
  return Uint8Array.of(...header, ...stitchBytes);
}

describe("JEF thread table", () => {
  it("has the placeholder plus 78 verbatim entries and is rebuilt on every call", () => {
    const set = getThreadSet();
    expect(set.length).toBe(79);
    expect(set[0]).toBeNull();
    expect(set[1]?.description).toBe("Black");
    expect(set[78]?.description).toBe("Bamboo");
    expect(set[78]?.color).toBe(0xe3ac81);
    set[1] = null;
    expect(getThreadSet()[1]).not.toBeNull();
  });
});

describe("JEF read parity with pystitch", () => {
  for (const name of NAMES) {
    it(`readJef(${name}.jef) equals pystitch's dump`, () => {
      const ref = loadReference(name, "jef");
      expect(toRefShape(readJef(ref.bytes))).toEqual(ref.dump);
    });
  }

  itPy("matches pystitch on a stop (colour 0), single zero jumps, jumps and the end record (live oracle)", () => {
    const bytes = handJef([2, 0, 5], [
      5, 250, //             stitch
      0x80, 0x02, 0, 0, //   zero jump: a trim
      3, 3,
      0x80, 0x02, 4, 0xfb, // jump
      0x80, 0x01, 0, 0, //   thread 0: stop
      1, 1,
      0x80, 0x01, 0, 0, //   colour change
      2, 2,
      0x80, 0x10, //         end
    ]);
    expect(toRefShape(readJef(bytes))).toEqual(pythonRead(bytes, null));
  });

  itPy("matches pystitch with reader settings trims/trim_at/trim_distance/clipping (live oracle)", () => {
    const ref = loadReference("trims", "jef");
    for (const settings of [
      { trims: true },
      { trim_at: 2 },
      { trim_distance: 1.5, clipping: false },
      { trims: true, trim_at: null, trim_distance: null },
    ]) {
      expect(toRefShape(readJef(ref.bytes, settings)), JSON.stringify(settings)).toEqual(pythonRead(ref.bytes, settings));
    }
  });

  itPy("maps a palette index past the table through modulo (live oracle)", () => {
    const bytes = handJef([79, 80 + 78, 3], [1, 1, 0x80, 0x10]);
    expect(toRefShape(readJef(bytes))).toEqual(pythonRead(bytes, null));
  });
});

describe("JEF write parity with pystitch", () => {
  for (const name of NAMES) {
    it(`writeJef(${name}) is byte-identical to pystitch`, () => {
      const ref = loadReference(name, "jef");
      expect(same(writeJef(fromJson(loadJson(name)), SETTINGS), ref.bytes)).toBe(true);
    });
    it(`readJef(writeJef(${name})) equals pystitch's dump of its own file`, () => {
      const ref = loadReference(name, "jef");
      expect(toRefShape(readJef(writeJef(fromJson(loadJson(name)), SETTINGS)))).toEqual(ref.dump);
    });
  }

  it("colors120 maps 120 colour stops onto the 78-entry table exactly as pystitch does", () => {
    const ref = loadReference("colors120", "jef");
    const out = writeJef(fromJson(loadJson("colors120")), SETTINGS);
    expect(same(out, ref.bytes)).toBe(true);
    const palette = new DataView(out.buffer, out.byteOffset).getInt32(24, true);
    expect(palette).toBe(120);
  });

  it("does not modify the source pattern when encoding", () => {
    const p = fromJson(loadJson("bigjump"));
    const before = JSON.stringify(p.stitches);
    writeJef(p, SETTINGS);
    expect(JSON.stringify(p.stitches)).toBe(before);
  });

  it("normalizes with the merged settings before writing (as write_embroidery does)", () => {
    const p = fromJson(loadJson("bigjump"));
    const direct = writeJef(p, SETTINGS);
    const manual = writeJef(normalize(p, effectiveSettings("jef", { encode: true, full_jump: true, trims: true })), {
      encode: false,
      trims: true,
      date: DATE,
    });
    expect(same(direct, manual)).toBe(true);
  });

  itPy("matches pystitch with trims false (live oracle)", () => {
    const json = withFillerThreads(loadJson("trims"));
    const extra = { trims: false };
    const expected = pythonWrite(json, "jef", extra);
    expect(same(writeJef(fromJson(json), { ...SETTINGS, ...extra }), expected)).toBe(true);
  });

  itPy("matches pystitch with trim_at 5 (live oracle)", () => {
    const json = withFillerThreads(loadJson("trims"));
    const extra = { trim_at: 5 };
    const expected = pythonWrite(json, "jef", extra);
    expect(same(writeJef(fromJson(json), { ...SETTINGS, ...extra }), expected)).toBe(true);
  });

  itPy("matches pystitch with encode off (raw TRIM/JUMP/STOP, live oracle)", () => {
    const json = withFillerThreads(loadJson("trims"));
    const extra = { encode: false };
    const expected = pythonWrite(json, "jef", extra);
    expect(same(writeJef(fromJson(json), { ...SETTINGS, ...extra }), expected)).toBe(true);
  });

  itPy("matches pystitch for STOP commands (toggling palette 0, live oracle)", () => {
    const json = withFillerThreads(loadJson("colors3"));
    const s = json.stitches;
    json.stitches.splice(3, 0, [s[2][0], s[2][1], STOP]);
    json.stitches.splice(6, 0, [s[5][0], s[5][1], STOP]);
    json.stitches.splice(9, 0, [s[8][0], s[8][1], STOP]);
    const expected = pythonWrite(json, "jef");
    expect(same(writeJef(fromJson(json), SETTINGS), expected)).toBe(true);
  });

  itPy("picks the second-nearest JEF colour for neighbouring threads that collapse to one entry (live oracle)", () => {
    const json: RefDump = {
      stitches: [[0, 0, STITCH], [10, 0, STITCH], [10, 0, COLOR_CHANGE], [20, 0, STITCH], [20, 0, COLOR_CHANGE], [30, 0, STITCH], [30, 0, END]],
      threads: [
        { color: "#fe0000", description: "a", catalog_number: null, brand: null },
        { color: "#fd0101", description: "b", catalog_number: null, brand: null },
        { color: "#fd0101", description: "c", catalog_number: null, brand: null },
      ],
      extras: {},
    };
    const expected = pythonWrite(json, "jef");
    expect(same(writeJef(fromJson(json), SETTINGS), expected)).toBe(true);
  });

  it("fills missing threads with filler colours like fix_color_count (colour-less DST-style input)", () => {
    const json = loadJson("colors3");
    const p = fromJson(json);
    p.threads = [];
    const out = writeJef(p, SETTINGS);
    expect(out.length).toBeGreaterThan(0x74);
    expect(readJef(out).threads.length).toBe(3);
  });

  it("writes the current local time as the date when none is given (the rest equals pystitch's bytes)", () => {
    const before = new Date();
    const out = writeJef(fromJson(loadJson("lines")));
    const after = new Date();
    const stamp = new TextDecoder().decode(out.subarray(8, 22));
    expect(stamp).toMatch(/^\d{14}$/);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const fmt = (d: Date): string =>
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    expect(stamp >= fmt(before) && stamp <= fmt(after)).toBe(true);
    const ref = loadReference("lines", "jef").bytes;
    expect(same(out.subarray(22), ref.subarray(22))).toBe(true);
    expect(same(out.subarray(0, 8), ref.subarray(0, 8))).toBe(true);
  });

  itPy("refuses an empty pattern (pystitch raises on its infinite bounds)", () => {
    expect(() => writeJef(new EmbPattern(), SETTINGS)).toThrow();
    expect(() => pythonWrite({ stitches: [], threads: [], extras: {} }, "jef")).toThrow();
  });
});

describe("getJefHoopSize", () => {
  const pythonHoop = (w: number, h: number): number =>
    Number(
      execFileSync(PY, ["-c", "import sys\nfrom pystitch.JefWriter import get_jef_hoop_size\nprint(get_jef_hoop_size(int(sys.argv[1]), int(sys.argv[2])))", String(w), String(h)])
        .toString("utf8")
        .trim(),
    );
  itPy("returns pystitch's codes for 100x100, 140x200 and 400x400 mm", () => {
    expect(getJefHoopSize(1000, 1000)).toBe(pythonHoop(1000, 1000));
    expect(getJefHoopSize(1400, 2000)).toBe(pythonHoop(1400, 2000));
    expect(getJefHoopSize(4000, 4000)).toBe(pythonHoop(4000, 4000));
    // Values read from JefWriter.py: 100x100 mm is HOOP_126X110 (3). 140x200 mm is NOT < 1400 x < 2000 (strict), nor
    // < 2000, so pystitch falls through to HOOP_110X110 (0); 400x400 mm falls through too.
    expect(getJefHoopSize(1000, 1000)).toBe(3);
    expect(getJefHoopSize(1400, 2000)).toBe(0);
    expect(getJefHoopSize(4000, 4000)).toBe(0);
  });
  itPy("matches pystitch at every threshold", () => {
    for (const [w, h] of [[499, 499], [500, 100], [100, 500], [1259, 1099], [1260, 100], [100, 1100], [1399, 1999], [1400, 100], [100, 2000], [1999, 1999], [2000, 100], [0, 0]]) {
      expect(getJefHoopSize(w, h), `${w}x${h}`).toBe(pythonHoop(w, h));
    }
  });
});

describe("JEF reader on bad input", () => {
  it("rejects empty and truncated headers with an error (pystitch raises too)", () => {
    expect(() => readJef(new Uint8Array(0))).toThrow();
    expect(() => readJef(new Uint8Array(10))).toThrow();
    const ref = loadReference("lines", "jef");
    expect(() => readJef(ref.bytes.subarray(0, 0x40))).toThrow();
  });
  itPy("pystitch raises on a truncated header too", () => {
    expect(pythonThrowsOnRead(new Uint8Array(10))).toBe(true);
  });
  itPy("reads a file truncated inside the stitch data without throwing", () => {
    const ref = loadReference("lines", "jef");
    const p = readJef(ref.bytes.subarray(0, ref.bytes.length - 3));
    expect(p.stitches.length).toBeGreaterThan(0);
    expect(toRefShape(p)).toEqual(pythonRead(ref.bytes.subarray(0, ref.bytes.length - 3), null));
  });
  itPy("rejects a colour change with no thread left, as pystitch does (IndexError)", () => {
    const bytes = handJef([2], [1, 1, 0x80, 0x01, 0, 0, 1, 1, 0x80, 0x10]);
    expect(pythonThrowsOnRead(bytes)).toBe(true);
    expect(() => readJef(bytes)).toThrow();
  });
  it("a PNG-like blob either throws or reads, never hangs", () => {
    const blob = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7));
    try {
      readJef(blob);
    } catch {
      /* fine */
    }
  });
});

describeLocalReadParity("JEF", "jef", (b) => readJef(b));


describe("colour 0 in the JEF palette (same thread list as pystitch)", () => {
  /** colors3.jef (indices 33, 61, 75) with its first palette entry set to 0, as some writers do. */
  const firstIsZero = (): Uint8Array => {
    const b = Uint8Array.from(loadReference("colors3", "jef").bytes);
    b.fill(0, 0x74, 0x78);
    return b;
  };
  const pyDump = (b: Uint8Array): RefRead => {
    const r = pythonReadFile(b, "jef");
    if ("error" in r) throw new Error(r.error);
    return r;
  };

  itPy("keeps a placeholder where pystitch keeps None, so every block keeps its thread", () => {
    const b = firstIsZero();
    const expected = pyDump(b);
    expect(expected.threads[0]).toBeNull();
    expect(expected.threads).toHaveLength(3);
    const p = readJef(b);
    expect(toRefShape(p)).toEqual(expected);
    // Block 1 and 2 keep palette entries 61 and 75 (dropping the placeholder used to shift them to blocks 0 and 1).
    const set = getThreadSet();
    expect(p.threads[1].color).toBe(set[61]!.color);
    expect(p.threads[2].color).toBe(set[75]!.color);
    // Everything else sees the deterministic filler for that index.
    expect(isPlaceholder(p.threads[0])).toBe(true);
    expect(p.threads[0].color).toBe(FILLER_COLORS[0]);
  });

  itPy("converts to PES, DST, JEF, EXP and VP3 exactly as pystitch does with the filler in place of its None", () => {
    const b = firstIsZero();
    const filled = withFillerThreads(pyDump(b));
    expect(filled.threads[0]).toEqual({ color: "#" + FILLER_COLORS[0].toString(16).padStart(6, "0"), description: "Random", catalog_number: null, brand: null });
    const p = readJef(b);
    expect(same(writePes(p.copy()), pythonWrite(filled, "pes"))).toBe(true);
    expect(same(writeDst(p.copy()), pythonWrite(filled, "dst"))).toBe(true);
    expect(same(writeJef(p.copy(), SETTINGS), pythonWrite(filled, "jef"))).toBe(true);
    expect(same(writeExp(p.copy()), pythonWrite(filled, "exp"))).toBe(true);
    expect(same(writeVp3(p.copy()), pythonWrite(filled, "vp3"))).toBe(true);
    // Through the API: the PES has block 1 in palette entry 61's nearest PEC colour, not block 2's.
    const pes = readPes(convert(b, "design.jef", "pes").bytes);
    const fromPy = readPes(pythonWrite(filled, "pes"));
    expect(pes.threads.map((t) => t.color)).toEqual(fromPy.threads.map((t) => t.color));
  });

  itPy("pystitch's own writers crash on the None (which is why the filler stands in)", () => {
    const real = pyDump(firstIsZero());
    for (const ext of ["pes", "jef", "vp3"]) expect(() => pythonWrite(real, ext), ext).toThrow();
  });

  itPy("a single-colour file whose only entry is colour 0 writes all five formats as pystitch does with the filler", () => {
    for (const name of ["fill", "lines", "large"]) {
      const b = Uint8Array.from(loadReference(name, "jef").bytes);
      expect(u32(b, 24), name).toBe(1);
      b.fill(0, 0x74, 0x78);
      const real = pyDump(b);
      expect(real.threads, name).toEqual([null]);
      const filled = withFillerThreads(real);
      const p = readJef(b);
      expect(toRefShape(p)).toEqual(real);
      expect(same(writePes(p.copy()), pythonWrite(filled, "pes")), `${name} pes`).toBe(true);
      expect(same(writeDst(p.copy()), pythonWrite(filled, "dst")), `${name} dst`).toBe(true);
      expect(same(writeJef(p.copy(), SETTINGS), pythonWrite(filled, "jef")), `${name} jef`).toBe(true);
      expect(same(writeExp(p.copy()), pythonWrite(filled, "exp")), `${name} exp`).toBe(true);
      expect(same(writeVp3(p.copy()), pythonWrite(filled, "vp3")), `${name} vp3`).toBe(true);
      // pystitch's real writers: DST and EXP never look at the thread and give the same bytes; the others crash.
      expect(same(writeDst(p.copy()), pythonWrite(real, "dst")), `${name} dst real`).toBe(true);
      expect(same(writeExp(p.copy()), pythonWrite(real, "exp")), `${name} exp real`).toBe(true);
      for (const ext of ["pes", "jef", "vp3"]) expect(() => pythonWrite(real, ext), `${name} ${ext} real`).toThrow();
    }
  });

  it("a single-colour file whose only entry is colour 0: filler in the preview, no colour warnings", () => {
    // colors3 cut to its first block: one palette entry, 0.
    const one = Uint8Array.from(loadReference("single", "jef").bytes);
    one.fill(0, 0x74, 0x78);
    const p = readEmbroidery(one, "one.jef");
    expect(toRefShape(p).threads).toEqual([null]);
    expect(computeStats(p).colorList).toEqual(["#" + FILLER_COLORS[0].toString(16).padStart(6, "0")]);
    for (const to of ["dst", "exp", "pes", "jef"] as const) expect(conversionWarnings(p, to), to).toEqual([]);
  });
});
