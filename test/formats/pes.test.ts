import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readPes, writePes } from "../../src/formats/pes";
import { drawScaled, getBlank, getGraphicAsString } from "../../src/formats/pecGraphics";
import { readDst } from "../../src/formats/dst";
import { getThreadSet } from "../../src/threads/pec";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings, type WriterSettings } from "../../src/core/settings";
import { normalize } from "../../src/core/encoder";
import { EmbPattern } from "../../src/core/pattern";
import { COLOR_CHANGE, END, JUMP, STITCH, STOP, TRIM } from "../../src/core/constants";
import { FILLER_COLORS } from "../../src/core/thread";
import {
  corpusPath, fromJson, loadReference, pythonWrite, toRefShape, withFillerThreads, PARITY_DIR, PYTHON, SYNTHETIC_DIR, itPy, describePy, requirePython, HAS_PYTHON,
  type RefDump,
  type RefRead,
} from "../helpers/parity";
import { describeLocalReadParity } from "../helpers/localParity";

const NAMES = ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"];
const V6 = { ...INKSTITCH_EXPORT_SETTINGS, version: 6 };
const loadJson = (name: string): RefDump => JSON.parse(readFileSync(corpusPath(name, "json"), "utf8")) as RefDump;
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** A thread in the parity JSON, plus PesWriter's chart field. */
type OracleThread = RefDump["threads"][number] & { chart?: string | null };
type OracleJson = Omit<RefDump, "threads"> & { threads: OracleThread[] };

// pystitch with its random filler thread replaced by the TS port's deterministic one, so patterns with
// missing threads can be compared byte for byte too. Everything else is unpatched pystitch 1.0.1.
const WRITE_ORACLE = `
import sys, json, io
from pystitch import EmbPattern, EmbThread, PesWriter
FILLER = json.loads(sys.argv[1])
def get_thread_or_filler(self, index):
    if len(self.threadlist) <= index:
        t = EmbThread()
        t.color = FILLER[index % len(FILLER)]
        t.description = "Random"
        return t
    return self.threadlist[index]
EmbPattern.get_thread_or_filler = get_thread_or_filler
data = json.loads(sys.stdin.read())
p = EmbPattern()
for x, y, cmd in data["stitches"]:
    p.add_stitch_absolute(cmd, x, y)
for t in data["threads"]:
    th = EmbThread()
    th.set(t["color"])
    th.description = t.get("description")
    th.catalog_number = t.get("catalog_number")
    th.brand = t.get("brand")
    th.chart = t.get("chart")
    p.add_thread(th)
for k, v in (data.get("extras") or {}).items():
    p.extras[k] = v
settings = {"encode": True, "full_jump": True, "trims": True}
settings.update(data["settings"])
buf = io.BytesIO()
EmbPattern.write_embroidery(PesWriter, p, buf, settings)
sys.stdout.buffer.write(buf.getvalue())
`;

/** pystitch's PES bytes for `json` (deterministic filler threads), with `settings` merged over Ink/Stitch's. */
function oracleWrite(json: OracleJson, settings: Record<string, unknown> = {}): Uint8Array {
  requirePython();
  const out = execFileSync(PYTHON, ["-c", WRITE_ORACLE, JSON.stringify(FILLER_COLORS)], {
    input: JSON.stringify({ ...json, settings }),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Uint8Array(out);
}

/** The TS pattern for an OracleJson (fromJson plus the chart field). */
function tsPattern(json: OracleJson): EmbPattern {
  const p = fromJson(json as RefDump);
  json.threads.forEach((t, i) => {
    p.threads[i].chart = t.chart ?? null;
  });
  return p;
}

function expectSameAsOracle(json: OracleJson, settings: Record<string, unknown> = {}): void {
  const expected = oracleWrite(json, settings);
  const actual = writePes(tsPattern(json), { ...INKSTITCH_EXPORT_SETTINGS, ...settings } as WriterSettings);
  expect(Buffer.from(actual).toString("hex")).toBe(Buffer.from(expected).toString("hex"));
}

function oracleThrowsOnWrite(json: OracleJson, settings: Record<string, unknown> = {}): boolean {
  requirePython();
  try {
    oracleWrite(json, settings);
    return false;
  } catch {
    return true;
  }
}

const READ_ORACLE = `
import sys, io, json
sys.path.insert(0, sys.argv[1])
from dump import dump_pattern
from pystitch import PesReader, EmbPattern
data = sys.stdin.buffer.read()
lengths = json.loads(sys.argv[2])
out = []
for n in lengths:
    p = EmbPattern()
    try:
        PesReader.read(io.BytesIO(data if n < 0 else data[:n]), p)
        out.append(dump_pattern(p))
    except Exception as e:
        out.append({"error": type(e).__name__})
print(json.dumps(out))
`;

type ReadResult = RefRead | { error: string };

/** PesReader.read of `bytes` (or of each prefix of the given lengths; -1 = all) in the parity dump shape. */
function pythonReadMany(bytes: Uint8Array, lengths: number[]): ReadResult[] {
  requirePython();
  const out = execFileSync(PYTHON, ["-c", READ_ORACLE, PARITY_DIR, JSON.stringify(lengths)], {
    input: bytes,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(out.toString("utf8")) as ReadResult[];
}
const pythonRead = (bytes: Uint8Array): ReadResult => pythonReadMany(bytes, [-1])[0];

function tsRead(bytes: Uint8Array): ReadResult {
  try {
    return toRefShape(readPes(bytes));
  } catch {
    return { error: "thrown" };
  }
}

/** Compare TS and pystitch reads: both throw, or both give the same dump. */
function expectSameRead(actual: ReadResult, expected: ReadResult, label: string): void {
  if ("error" in expected) {
    expect("error" in actual, `${label}: pystitch raised ${expected.error}`).toBe(true);
  } else {
    expect(actual, label).toEqual(expected);
  }
}

// ------------------------------------------------------------------------------------------------ hand-built PES
const enc = new TextEncoder();
const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const zeros = (n: number): number[] => new Array<number>(n).fill(0);
/** A PES string: length byte (bytes) then UTF-8. Null writes a 0 length. */
const pstr = (s: string | null): number[] => (s === null ? [0] : [enc.encode(s).length, ...enc.encode(s)]);
interface HThread {
  catalog: string | null;
  rgb: number;
  description: string | null;
  brand: string | null;
  chart: string | null;
}
const pthread = (t: HThread): number[] => [
  ...pstr(t.catalog), (t.rgb >> 16) & 0xff, (t.rgb >> 8) & 0xff, t.rgb & 0xff, ...zeros(5), ...pstr(t.description), ...pstr(t.brand), ...pstr(t.chart),
];
const META = ["Design", "Flowers", "Ada", "rose,leaf", "A comment"];
const meta = (m: Array<string | null> = META): number[] => m.flatMap(pstr);
const threadTable = (threads: HThread[], counts: [number, number, number] = [0, 0, 0]): number[] => [
  ...u16(counts[0]), ...u16(counts[1]), ...u16(counts[2]), ...u16(threads.length), ...threads.flatMap(pthread),
];
const HTHREADS: HThread[] = [
  { catalog: "900", rgb: 0x112233, description: "Night", brand: "Madeira", chart: "Polyneon" },
  { catalog: null, rgb: 0xa0b0c0, description: "Fog", brand: null, chart: null },
  { catalog: "7", rgb: 0xfe0102, description: null, brand: "Isacord", chart: "Isa" },
  { catalog: "8", rgb: 0x00ff00, description: "Extra", brand: "B", chart: "C" },
];

/** Header bytes (after the signature and the PEC offset) laid out as PesReader reads each version. */
function headerFor(version: string, threads: HThread[], counts: [number, number, number] = [0, 0, 0]): number[] {
  const t = threadTable(threads, counts);
  switch (version) {
    case "#PES0040":
      return [...zeros(4), ...meta()];
    case "#PES0050":
    case "#PES0055":
    case "#PES0056":
      return [...zeros(4), ...meta(), ...zeros(24), ...pstr("pic.png"), ...zeros(24), ...t];
    case "#PES0060":
    case "#PES0070":
      return [...zeros(4), ...meta(), ...zeros(36), ...pstr("img.bmp"), ...zeros(24), ...t];
    case "#PES0080":
      return [...zeros(4), ...meta(), ...zeros(38), ...pstr("img8.bmp"), ...zeros(26), ...t];
    case "#PES0090":
      return [...zeros(4), ...meta(), ...zeros(14), ...pstr("Hoop 9"), ...zeros(30), ...pstr("img9.bmp"), ...zeros(34), ...t];
    case "#PES0100":
      return [...zeros(4), ...meta(), ...zeros(14), ...pstr("Hoop 10"), ...zeros(38), ...pstr("img10.bmp"), ...zeros(34), ...t];
    default:
      return [...zeros(10)];
  }
}

/** The PEC block (from the PEC offset to the end) of a pystitch-written PES file. */
function pecBlockOf(bytes: Uint8Array): Uint8Array {
  const offset = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  return bytes.subarray(offset);
}

function buildPes(signature: string, header: number[], pec: Uint8Array): Uint8Array {
  return Uint8Array.of(...enc.encode(signature), ...u32(12 + header.length), ...header, ...pec);
}

// ------------------------------------------------------------------------------------------------ tests
describe("PEC thread table", () => {
  itPy("equals pystitch's get_thread_set() entry for entry (live oracle)", () => {
    const code = [
      "import json",
      "from pystitch.EmbThreadPec import get_thread_set",
      "print(json.dumps([None if t is None else [t.color, t.description, t.catalog_number, t.brand, t.chart] for t in get_thread_set()]))",
    ].join("\n");
    const expected = JSON.parse(execFileSync(PYTHON, ["-c", code]).toString("utf8")) as unknown[];
    const actual = getThreadSet().map((t) => (t === null ? null : [t.color, t.description, t.catalogNumber, t.brand, t.chart]));
    expect(actual).toHaveLength(65);
    expect(actual).toEqual(expected);
  });
});

describe("PES read parity with pystitch", () => {
  for (const name of NAMES) {
    for (const ext of ["pes", "v6.pes"]) {
      it(`readPes(${name}.${ext}) equals pystitch's dump`, () => {
        const ref = loadReference(name, ext);
        expect(toRefShape(readPes(ref.bytes))).toEqual(ref.dump);
      });
    }
  }

  it("keeps the PEC thumbnails in extras, as pystitch's pec_graphic_N metadata", () => {
    const ref = loadReference("colors3", "pes");
    const p = readPes(ref.bytes);
    const g0 = p.extras["pec_graphic_0"] as [Uint8Array, number, unknown];
    expect(g0[0]).toHaveLength(6 * 38);
    expect(g0[1]).toBe(6);
    expect(g0[2]).toBeNull();
    expect(p.extras["pec_graphic_3"]).toBeDefined();
    expect(p.extras["pec_graphic_4"]).toBeUndefined();
  });

  const pec3 = pecBlockOf(loadReference("colors3", "pes").bytes);
  const versions = ["#PES0001", "#PES0020", "#PES0022", "#PES0030", "#PES0040", "#PES0050", "#PES0055", "#PES0056", "#PES0060", "#PES0070", "#PES0080", "#PES0090", "#PES0100", "#PESXXXX"];
  for (const version of versions) {
    itPy(`reads a ${version} header like pystitch: metadata, threads 1:1 (live oracle)`, () => {
      const bytes = buildPes(version, headerFor(version, HTHREADS), pec3);
      expectSameRead(tsRead(bytes), pythonRead(bytes), version);
    });
  }
  for (const version of ["#PES0050", "#PES0060", "#PES0080", "#PES0090", "#PES0100"]) {
    itPy(`reads a ${version} header with fewer threads than PEC colours (tabled mode, live oracle)`, () => {
      const bytes = buildPes(version, headerFor(version, HTHREADS.slice(0, 2)), pec3);
      expectSameRead(tsRead(bytes), pythonRead(bytes), version);
    });
  }
  itPy("stops reading the thread table when programmable fills, motifs or feathers are present (live oracle)", () => {
    for (const counts of [[1, 0, 0], [0, 2, 0], [0, 0, 3]] as Array<[number, number, number]>) {
      const bytes = buildPes("#PES0060", headerFor("#PES0060", HTHREADS, counts), pec3);
      expectSameRead(tsRead(bytes), pythonRead(bytes), JSON.stringify(counts));
    }
  });
  itPy("maps repeated PEC colour indices through the thread table (tabled mode with reuse, live oracle)", () => {
    const json: RefDump = {
      stitches: [[0, 0, STITCH], [50, 0, STITCH], [50, 0, COLOR_CHANGE], [0, 50, STITCH], [50, 50, STITCH], [50, 50, COLOR_CHANGE], [0, 90, STITCH], [90, 90, STITCH]],
      threads: [
        { color: "#ff0000", description: "r", catalog_number: null, brand: null },
        { color: "#0000ff", description: "b", catalog_number: null, brand: null },
        { color: "#ff0000", description: "r", catalog_number: null, brand: null },
      ],
      extras: {},
    };
    const pec = pecBlockOf(pythonWrite(json, "pes"));
    for (const n of [0, 1, 2, 3]) {
      const bytes = buildPes("#PES0060", headerFor("#PES0060", HTHREADS.slice(0, n)), pec);
      expectSameRead(tsRead(bytes), pythonRead(bytes), `${n} header threads`);
    }
  });
  itPy("reads a bare #PEC0001 file (live oracle)", () => {
    const bytes = Uint8Array.of(...enc.encode("#PEC0001"), ...pec3);
    expectSameRead(tsRead(bytes), pythonRead(bytes), "#PEC0001");
    expect(toRefShape(readPes(bytes)).threads).toHaveLength(3);
  });
  itPy("reads non-UTF-8 strings and labels as pystitch does (None, then misaligned, live oracle)", () => {
    const bad = [3, 0xff, 0xfe, 0xfd];
    const header = [...zeros(4), ...bad, ...meta().slice(0), ...zeros(36), 0, ...zeros(24), ...threadTable(HTHREADS)];
    const pec = Uint8Array.from(pec3);
    pec[3] = 0xc3; // breaks the UTF-8 of the PEC label
    const bytes = buildPes("#PES0060", header, pec);
    expectSameRead(tsRead(bytes), pythonRead(bytes), "non-utf8");
  });
});

describe("PES write parity with pystitch", () => {
  for (const name of NAMES) {
    it(`writePes(${name}) v1 is byte-identical to pystitch`, () => {
      const ref = loadReference(name, "pes");
      expect(same(writePes(fromJson(loadJson(name))), ref.bytes)).toBe(true);
    });
    it(`writePes(${name}, {version: 6}) is byte-identical to pystitch`, () => {
      const ref = loadReference(name, "v6.pes");
      expect(same(writePes(fromJson(loadJson(name)), V6), ref.bytes)).toBe(true);
    });
    it(`readPes(writePes(${name})) equals pystitch's dumps (v1 and v6)`, () => {
      expect(toRefShape(readPes(writePes(fromJson(loadJson(name)))))).toEqual(loadReference(name, "pes").dump);
      expect(toRefShape(readPes(writePes(fromJson(loadJson(name)), V6)))).toEqual(loadReference(name, "v6.pes").dump);
    });
  }

  it("colors120: 120 threads onto the 64-entry PEC palette in CPython set order (v1 and v6)", () => {
    const json = loadJson("colors120");
    const v1 = writePes(fromJson(json));
    const v6 = writePes(fromJson(json), V6);
    expect(same(v1, loadReference("colors120", "pes").bytes)).toBe(true);
    expect(same(v6, loadReference("colors120", "v6.pes").bytes)).toBe(true);
    // The PEC colour table: count - 1, then one PEC index per thread.
    const pec = pecBlockOf(v1);
    expect(pec[48]).toBe(119);
  });

  it("single: a one-stitch, one-colour design (v1 and v6)", () => {
    const json = loadJson("single");
    expect(same(writePes(fromJson(json)), loadReference("single", "pes").bytes)).toBe(true);
    expect(same(writePes(fromJson(json), V6), loadReference("single", "v6.pes").bytes)).toBe(true);
  });

  it("does not modify the source pattern when encoding", () => {
    const p = fromJson(loadJson("colors3"));
    const before = JSON.stringify(toRefShape(p));
    writePes(p, V6);
    expect(JSON.stringify(toRefShape(p))).toBe(before);
  });

  it("normalizes with the merged settings before writing (as write_embroidery does)", () => {
    const p = fromJson(loadJson("bigjump"));
    const manual = writePes(normalize(p, effectiveSettings("pes", INKSTITCH_EXPORT_SETTINGS)), { encode: false });
    expect(same(writePes(p), manual)).toBe(true);
  });

  itPy("matches pystitch for v6 metadata, thread descriptions, catalog numbers, brands and charts (live oracle)", () => {
    const json: OracleJson = {
      ...loadJson("colors3"),
      threads: [
        { color: "#d62828", description: "Poppy Red", catalog_number: "1147", brand: "Madeira", chart: "Polyneon 40" },
        { color: "#1d70b8", description: null, catalog_number: null, brand: null, chart: null },
        { color: "#2a9d3f", description: "x".repeat(300), catalog_number: "9".repeat(256), brand: "B".repeat(255), chart: "" },
      ],
      extras: { name: "Rose garden", category: "Flowers", author: "Ada", keywords: "rose, leaf", comments: "c".repeat(400) },
    };
    expectSameAsOracle(json, { version: 6 });
    expectSameAsOracle(json, { version: 1 });
  });

  itPy("matches pystitch for non-ASCII metadata (length byte counts code points, live oracle)", () => {
    const json: OracleJson = {
      ...loadJson("colors3"),
      threads: loadJson("colors3").threads.map((t, i) => ({ ...t, description: ["Kırmızı", "Mavi 🧵", "Yeşil"][i] })),
      extras: { name: "Çiçek bahçesi 🌸", author: "Ünal", comments: "é".repeat(300) },
    };
    expectSameAsOracle(json, { version: 6 });
    expectSameAsOracle(json, {});
    // pystitch cannot read its own v6 header back here (the byte count differs from the code-point count).
    const bytes = writePes(tsPattern(json), V6);
    expectSameRead(tsRead(bytes), pythonRead(bytes), "non-ascii v6 read-back");
  });

  itPy("matches pystitch for PEC labels: long, punctuated, Unicode, empty and missing names (live oracle)", () => {
    for (const name of ["abcdefghijklmnop", "My design (1).pes", "Çiçek", "!!!", "", "x", undefined]) {
      const json: OracleJson = { ...loadJson("single"), extras: name === undefined ? {} : { name } };
      expectSameAsOracle(json);
      expectSameAsOracle(json, { version: 6 });
    }
  });

  itPy("matches pystitch for the truncated variants and version spellings (live oracle)", () => {
    const json = loadJson("colors3");
    for (const settings of [
      { version: "1t" }, { version: "6t" }, { truncated: true }, { truncated: true, version: 6 }, { "pes version": 6 },
      { "pes version": 6, version: 1 }, { version: "6" }, { version: "6.0" }, { version: 6.0 }, { version: " 1 " },
    ]) {
      expectSameAsOracle(json, settings);
    }
  });

  itPy("writes nothing for a version pystitch does not write (e.g. 5), as pystitch does (live oracle)", () => {
    const json = loadJson("colors3");
    for (const version of [5, "4", 2]) {
      expect(oracleWrite(json, { version })).toHaveLength(0);
      expect(writePes(fromJson(json), { ...INKSTITCH_EXPORT_SETTINGS, version })).toHaveLength(0);
    }
  });

  it("rejects version values pystitch cannot parse (float() raises)", () => {
    const json = loadJson("single");
    for (const version of ["extended", "t", null]) {
      if (HAS_PYTHON) expect(oracleThrowsOnWrite(json, { version })).toBe(true);
      expect(() => writePes(fromJson(json), { ...INKSTITCH_EXPORT_SETTINGS, version })).toThrow();
    }
  });

  itPy("matches pystitch for STOP commands (turned into duplicate colours, live oracle)", () => {
    const json = loadJson("colors3");
    const s = json.stitches;
    json.stitches.splice(3, 0, [s[2][0], s[2][1], STOP]);
    json.stitches.splice(20, 0, [s[19][0], s[19][1], STOP]);
    expectSameAsOracle(json);
    expectSameAsOracle(json, { version: 6 });
  });

  itPy("matches pystitch for trims, jumps and stops with encode off (raw commands, live oracle)", () => {
    const json: RefDump = {
      stitches: [
        [0, 0, JUMP], [0, 0, STITCH], [70, 0, STITCH], [70, 63, STITCH], [6, -64, STITCH], [6, -64, TRIM], [5006, 400, JUMP],
        [5006, 401, STITCH], [5006, 401, STOP], [5000, 300, STITCH], [5000, 300, COLOR_CHANGE], [4000, 300, JUMP], [4001, 302, STITCH], [4001, 302, END],
      ],
      threads: loadJson("colors3").threads,
      extras: { name: "raw" },
    };
    expectSameAsOracle(json, { encode: false });
    expectSameAsOracle(json, { encode: false, version: 6 });
  });

  itPy("matches pystitch for fractional coordinates with encode off (int() truncation and round(), live oracle)", () => {
    const json: RefDump = {
      stitches: [[0.5, 0.5, STITCH], [10.5, -3.5, STITCH], [21.49, 7.51, STITCH], [-12.5, 30.25, STITCH], [-12.5, 30.25, END]],
      threads: loadJson("single").threads,
      extras: {},
    };
    expectSameAsOracle(json, { encode: false });
    expectSameAsOracle(json, { encode: false, version: 6 });
  });

  itPy("writes a 0-colour design (only moves, no threads) like pystitch (deterministic filler, live oracle)", () => {
    const json: RefDump = { stitches: [[0, 0, JUMP], [300, 200, JUMP], [-100, 50, JUMP]], threads: [], extras: { name: "moves" } };
    for (const settings of [{}, { encode: false }]) {
      expectSameAsOracle(json, settings);
      // The PEC colour table takes its "no colours" form; pystitch reads that back as 256 colours.
      const bytes = writePes(fromJson(json), { ...INKSTITCH_EXPORT_SETTINGS, ...settings });
      expectSameRead(tsRead(bytes), pythonRead(bytes), "0-colour read-back");
      // Version 6 looks the jump segments' colour up in the (empty) thread list: pystitch raises TypeError.
      expect(oracleThrowsOnWrite(json, { ...settings, version: 6 })).toBe(true);
      expect(() => writePes(fromJson(json), { ...INKSTITCH_EXPORT_SETTINGS, ...settings, version: 6 })).toThrow(TypeError);
    }
  });

  itPy("writes 1-colour designs without threads like pystitch (deterministic filler, live oracle)", () => {
    for (const name of ["single", "fill", "trims"]) {
      const json = { ...loadJson(name), threads: [] };
      expectSameAsOracle(json);
      expectSameAsOracle(json, { version: 6 });
    }
  });

  itPy("uses filler threads for colour changes beyond the thread list (live oracle)", () => {
    const json = loadJson("colors3");
    json.threads = json.threads.slice(0, 1);
    json.stitches.push([210, 10, COLOR_CHANGE], [210, 10, COLOR_CHANGE], [220, 20, STITCH]);
    expectSameAsOracle(json);
    expectSameAsOracle(json, { version: 6 });
  });

  it("refuses more than 256 colours, as pystitch does (TooManyColorChangesError)", () => {
    const stitches: RefDump["stitches"] = [];
    const threads: RefDump["threads"] = [];
    for (let i = 0; i < 257; i++) {
      stitches.push([i, 0, STITCH], [i, 5, STITCH]);
      if (i < 256) stitches.push([i, 5, COLOR_CHANGE]);
      threads.push({ color: "#" + ((i * 99991) & 0xffffff).toString(16).padStart(6, "0"), description: null, catalog_number: null, brand: null });
    }
    const json: RefDump = { stitches, threads, extras: {} };
    expect(() => writePes(fromJson(json))).toThrow(/color changes/i);
    if (HAS_PYTHON) {
      expect(oracleThrowsOnWrite(json)).toBe(true);
      // 256 colours is the most a PEC colour table holds.
      const ok: RefDump = { stitches: stitches.slice(0, 256 * 3 - 1), threads: threads.slice(0, 256), extras: {} };
      expectSameAsOracle(ok);
    }
  }, 30_000);

  itPy("writes an empty pattern as pystitch does (the encoder leaves a lone END at 0,0, live oracle)", () => {
    const empty: RefDump = { stitches: [], threads: [], extras: {} };
    expectSameAsOracle(empty);
    expectSameAsOracle(empty, { version: 6 });
    expectSameAsOracle(empty, { version: "6t" });
  });

  it("refuses an empty pattern with encode off (pystitch raises on its infinite bounds)", () => {
    const empty: RefDump = { stitches: [], threads: [], extras: {} };
    for (const version of [1, 6]) {
      if (HAS_PYTHON) expect(oracleThrowsOnWrite(empty, { encode: false, version })).toBe(true);
      expect(() => writePes(new EmbPattern(), { encode: false, version })).toThrow(RangeError);
    }
  });
});

describePy("DST-sourced pattern with no threads into PES", () => {
  for (const name of ["colors3", "trims", "colors120"]) {
    for (const settings of [INKSTITCH_EXPORT_SETTINGS, V6]) {
      const v = settings === V6 ? "v6" : "v1";
      it(`${name}.dst -> PES ${v} equals pystitch with the same filler threads`, () => {
        const dstJson = toRefShape(readDst(loadReference(name, "dst").bytes)) as RefDump; // DST reads add no threads
        expect(dstJson.threads).toHaveLength(0);
        const padded = withFillerThreads(dstJson);
        const expected = pythonWrite(padded, "pes", settings === V6 ? { version: 6 } : undefined);
        const fromPadded = writePes(fromJson(padded), settings);
        expect(same(fromPadded, expected)).toBe(true);
        // The no-thread input takes the same filler path, so it writes the same file.
        expect(same(writePes(fromJson(dstJson), settings), fromPadded)).toBe(true);
        // And so does pystitch when its random filler is the deterministic one.
        expect(same(oracleWrite(dstJson, settings === V6 ? { version: 6 } : {}), fromPadded)).toBe(true);
      });
    }
  }
});

describe("PEC thumbnails (PecGraphics)", () => {
  const ORACLE = `
import sys, json
from pystitch.PecGraphics import draw_scaled, get_blank, get_graphic_as_string
cases = json.loads(sys.stdin.read())
out = []
for c in cases:
    g = get_blank()
    draw_scaled(c["extends"], c["points"], g, 6, c["buffer"])
    out.append([g, get_graphic_as_string(g)])
print(json.dumps(out))
`;
  itPy("draw_scaled matches pystitch, including points outside the bounds (negative indexes wrap, others skip)", () => {
    const cases = [
      { extends: [0, 0, 100, 100], points: [[0, 0], [100, 100], [50, 50], [-400, 20], [20, -400], [900, 900], [-5000, -5000]], buffer: 4 },
      { extends: [-10, -20, 30, 40], points: [[-10, -20], [30, 40], [0, 0], [12.5, -3.25]], buffer: 5 },
      { extends: [5, 5, 5, 5], points: [[5, 5], [6, 7]], buffer: 5 },
      { extends: [0, 0, 1000, 10], points: [[0, 0], [1000, 10], [500, 5], [1100, -2000]], buffer: 0 },
    ];
    const expected = JSON.parse(execFileSync(PYTHON, ["-c", ORACLE], { input: JSON.stringify(cases) }).toString("utf8")) as Array<[number[], string]>;
    cases.forEach((c, i) => {
      const g = getBlank();
      drawScaled(c.extends as [number, number, number, number], c.points as Array<[number, number]>, g, 6, c.buffer);
      expect(g, JSON.stringify(c)).toEqual(expected[i][0]);
      expect(getGraphicAsString(g)).toBe(expected[i][1]);
    });
  });
  it("getBlank is a fresh 6 x 38 copy of the verbatim blank icon", () => {
    const a = getBlank();
    expect(a).toHaveLength(228);
    a[0] = 0xff;
    expect(getBlank()[0]).toBe(0);
    expect(getBlank().slice(6, 12)).toEqual([0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
  });
});

describe("PES reader on bad input", () => {
  it("rejects empty and tiny input with an error (pystitch raises too)", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(5), enc.encode("#PES0001")]) {
      expect(() => readPes(bytes)).toThrow(/PES/);
    }
  });
  itPy("pystitch raises on empty and tiny input too", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(5), enc.encode("#PES0001")]) {
      expect("error" in pythonRead(bytes)).toBe(true);
    }
  });
  for (const [name, ext] of [["single", "pes"], ["single", "v6.pes"], ["colors3", "v6.pes"]]) {
    itPy(`every truncation of ${name}.${ext} reads (or fails) exactly as pystitch does`, () => {
      const bytes = loadReference(name, ext).bytes;
      const lengths = Array.from({ length: bytes.length + 1 }, (_, i) => i);
      const expected = pythonReadMany(bytes, lengths);
      for (const n of lengths) expectSameRead(tsRead(bytes.subarray(0, n)), expected[n], `${name}.${ext}[:${n}]`);
    }, 60_000);
  }
  itPy("terminates on a DST or PNG renamed .pes and on a PEC offset past the end", () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(300).fill(7));
    const dst = loadReference("colors3", "dst").bytes;
    const far = Uint8Array.from(loadReference("single", "pes").bytes);
    far[8] = 0xff;
    far[9] = 0xff;
    for (const [label, bytes] of [["png", png], ["dst", dst], ["far", far]] as Array<[string, Uint8Array]>) {
      expectSameRead(tsRead(bytes), pythonRead(bytes), label);
    }
  });
});

describeLocalReadParity("PES", "pes", (b) => readPes(b));
