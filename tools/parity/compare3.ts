// Read/write check of this TypeScript port against pystitch (the oracle), with an optional third engine: any other
// embroidery program or library whose results arrive only as files (JSON dumps in the parity schema plus the files it
// wrote) in a directory you pass with --third. Nothing here knows how that engine works; it compares outputs.
//
//   npx tsx tools/parity/compare3.ts [--limit N] [--third <dir> [--third-tag <tag>]]
//
// --limit N compares only the first N sources in order, which are the synthetic ones (54), then corpus/local.
// --third <dir>  the third engine's output directory. Without it the third-engine sections are skipped.
// --third-tag <tag>  the tag in that engine's file names (default "third"), see below.
// Exit code 1 when TS and pystitch disagree on any read or write (a bug in the port), else 0.
//
// Sources: corpus/synthetic/*.{pes,dst,jef,exp,vp3} and every embroidery file under corpus/local/ (except the --third
// directory, if it is inside corpus/local). For a source at corpus/<rel>, the third engine's files are
//   <dir>/<rel>.<tag>.json            its reading of the source
//   <dir>/<rel>.<tag>.<fmt>           the source as it writes <fmt>
//   <dir>/<rel>.<tag>.<fmt>.<tag>.json   its reading of that written file
// and an optional <dir>/manifest.json with a "summary" object of its own error counts.
//
// Checks:
//   1. Reads: pystitch vs TS (must be identical) [vs the third engine (command counts, needle path, colours)].
//   2. Writes: TS vs pystitch bytes for every source x format (must be identical).
//   3. The third engine's written files: read by pystitch, TS and the engine itself, and whether pystitch reads them
//      as the design the engine read from the source.
//   4. Sources that are one design in several formats (same folder and name): does each reader see the same design
//      in every format?
// Output: a summary on stdout, corpus/local/compare3-report.md and corpus/local/compare3-results.json.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbroideryReadError, readEmbroidery } from "../../src/api";
import { COLOR_CHANGE, COMMAND_MASK, END, JUMP, STITCH, STOP, TRIM } from "../../src/core/constants";
import type { EmbPattern } from "../../src/core/pattern";
import type { WriterSettings } from "../../src/core/settings";
import { readDst, writeDst } from "../../src/formats/dst";
import { readExp, writeExp } from "../../src/formats/exp";
import { readJef, writeJef } from "../../src/formats/jef";
import { readPes, writePes } from "../../src/formats/pes";
import { readVp3, writeVp3 } from "../../src/formats/vp3";
import { fromJson, toRefShape, withFillerThreads, type RefRead } from "../../test/helpers/parity";

type Fmt = "pes" | "dst" | "jef" | "exp" | "vp3";
const FORMATS: Fmt[] = ["pes", "dst", "jef", "exp", "vp3"];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "corpus");
const LOCAL = join(CORPUS, "local");

/** Value of `--name <value>`, or undefined. */
function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
/** The third engine's directory (--third), or null: then there is no third engine. */
const THIRD_DIR: string | null = option("--third") ? resolve(process.cwd(), option("--third")!) : null;
const THIRD_TAG = option("--third-tag") ?? "third";
const HAS_THIRD = THIRD_DIR !== null;
const PYTHON = join(ROOT, "tools", "parity", ".venv", "bin", "python");
const BATCH_PY = join(ROOT, "tools", "parity", "batch.py");
// write.py's settings: Ink/Stitch's export plus a fixed JEF date.
const SETTINGS: WriterSettings = { encode: true, full_jump: true, trims: true };
const JEF_SETTINGS: WriterSettings = { ...SETTINGS, date: "20260101000000" };

// ---------------------------------------------------------------- inputs

function fmtOf(path: string): Fmt | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const e = m ? m[1].toLowerCase() : "";
  return (FORMATS as string[]).includes(e) ? (e as Fmt) : null;
}

function walk(dir: string, out: string[], skip: string | null): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (p === skip) continue;
    if (statSync(p).isDirectory()) walk(p, out, skip);
    else if (fmtOf(p) !== null) out.push(p);
  }
}

function sources(): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(CORPUS, "synthetic")).sort()) {
    const p = join(CORPUS, "synthetic", e);
    if (fmtOf(p) !== null && statSync(p).isFile()) out.push(p);
  }
  walk(LOCAL, out, THIRD_DIR);
  return out;
}

/** "synthetic", or the first two folders under corpus/ (e.g. "local/packs"), for the per-source tables. */
function groupOf(src: string): string {
  const rel = relative(CORPUS, src).split("/");
  if (rel[0] === "synthetic") return "synthetic";
  return rel.slice(1, 3).join("/");
}

/** One design in several formats: same folder, same name, different extension. Synthetic v6 PES files excluded. */
function designKey(src: string): string | null {
  if (groupOf(src) === "synthetic") return null;
  return join(dirname(src), basename(src).replace(/\.[^.]+$/, ""));
}

// ---------------------------------------------------------------- pystitch in batches

function runPy(mode: "dump" | "write", lines: string[]): Promise<Array<Record<string, unknown>>> {
  if (lines.length === 0) return Promise.resolve([]);
  return new Promise((res, rej) => {
    const child = spawn(PYTHON, [BATCH_PY, mode], { cwd: join(ROOT, "tools", "parity"), stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => errs.push(b));
    child.on("error", rej);
    child.on("close", (code) => {
      if (code !== 0) return rej(new Error(`batch.py ${mode} exited ${code}: ${Buffer.concat(errs).toString("utf8").slice(-2000)}`));
      const text = Buffer.concat(chunks).toString("utf8");
      res(text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>));
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
}

/** A reading: dump.py's JSON (a null thread is pystitch's None, TS's PlaceholderThread), or the error. */
type Read = RefRead | { error: string };
interface PyRead { dump: Read }

async function pyDump(paths: string[]): Promise<Map<string, PyRead>> {
  const out = new Map<string, PyRead>();
  for (const r of await runPy("dump", paths)) {
    out.set(r.path as string, { dump: r.error !== undefined ? { error: r.error as string } : (r.dump as RefRead) });
  }
  return out;
}

/** How many null (None / placeholder) threads a reading has. */
const nullThreads = (d: Read | undefined): number => (d && !isErr(d) ? d.threads.filter((t) => t === null).length : 0);

// ---------------------------------------------------------------- TS side

const READERS: Record<Fmt, (b: Uint8Array) => EmbPattern> = {
  pes: (b) => readPes(b),
  dst: (b) => readDst(b),
  jef: (b) => readJef(b),
  exp: (b) => readExp(b),
  vp3: (b) => readVp3(b),
};

function tsWrite(p: EmbPattern, f: Fmt): Uint8Array {
  switch (f) {
    case "pes": return writePes(p, SETTINGS);
    case "dst": return writeDst(p, SETTINGS);
    case "jef": return writeJef(p, JEF_SETTINGS);
    case "exp": return writeExp(p, SETTINGS);
    case "vp3": return writeVp3(p, SETTINGS);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function tsRead(path: string, bytes: Uint8Array): Read {
  try {
    return toRefShape(READERS[fmtOf(path)!](bytes));
  } catch (e) {
    return { error: errText(e) };
  }
}

function apiVerdict(path: string, bytes: Uint8Array): string {
  try {
    readEmbroidery(bytes, path);
    return "ok";
  } catch (e) {
    return e instanceof EmbroideryReadError ? e.code : errText(e);
  }
}

// ---------------------------------------------------------------- comparison helpers

const isErr = (d: unknown): d is { error: string } => typeof d === "object" && d !== null && "error" in d;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (!deepEqual(ka, kb)) return false;
  for (const k of ka) if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** Where two dumps first differ, for the TS-vs-pystitch report. Null when identical. */
function firstDumpDiff(p: RefRead, t: RefRead): string | null {
  const n = Math.min(p.stitches.length, t.stitches.length);
  for (let i = 0; i < n; i++) {
    if (!deepEqual(p.stitches[i], t.stitches[i])) return `stitch ${i}: ${JSON.stringify(p.stitches[i])} vs ${JSON.stringify(t.stitches[i])}`;
  }
  if (p.stitches.length !== t.stitches.length) return `stitch count ${p.stitches.length} vs ${t.stitches.length}`;
  if (p.threads.length !== t.threads.length) return `thread count ${p.threads.length} vs ${t.threads.length}`;
  for (let i = 0; i < p.threads.length; i++) {
    if (!deepEqual(p.threads[i], t.threads[i])) return `thread ${i}: ${JSON.stringify(p.threads[i])} vs ${JSON.stringify(t.threads[i])}`;
  }
  if (!deepEqual(p.extras, t.extras)) return `extras ${JSON.stringify(p.extras)} vs ${JSON.stringify(t.extras)}`;
  return null;
}

interface Counts {
  records: number;
  stitch: number;
  jump: number;
  trim: number;
  stop: number;
  end: number;
  colorChange: number;
  other: number;
  threads: number;
}
const COUNT_KEYS = ["stitch", "jump", "trim", "stop", "end", "colorChange", "other", "threads"] as const;

function counts(d: RefRead): Counts {
  const c: Counts = { records: d.stitches.length, stitch: 0, jump: 0, trim: 0, stop: 0, end: 0, colorChange: 0, other: 0, threads: d.threads.length };
  for (const s of d.stitches) {
    switch (s[2] & COMMAND_MASK) {
      case STITCH: c.stitch++; break;
      case JUMP: c.jump++; break;
      case TRIM: c.trim++; break;
      case STOP: c.stop++; break;
      case END: c.end++; break;
      case COLOR_CHANGE: c.colorChange++; break;
      default: c.other++;
    }
  }
  return c;
}

function countDiffs(a: RefRead, b: RefRead): string[] {
  const ca = counts(a);
  const cb = counts(b);
  return COUNT_KEYS.filter((k) => ca[k] !== cb[k]).map((k) => `${k} ${ca[k]}/${cb[k]}`);
}

/**
 * What the machine sews: the needle positions (STITCH records) in order, with "C" per colour change or stop.
 * Jumps, trims and END are left out; their conventions differ between readers.
 */
type Tok = [number, number] | "C";
function needlePath(d: RefRead): Tok[] {
  const out: Tok[] = [];
  for (const s of d.stitches) {
    const c = s[2] & COMMAND_MASK;
    if (c === STITCH) out.push([s[0], s[1]]);
    else if (c === COLOR_CHANGE || c === STOP) out.push("C");
  }
  return out;
}

/**
 * The needle path without what writers legitimately add: repeated penetrations at one point, and the in-between
 * points of a long stitch split into shorter ones (a point within 1 unit of the straight line between its kept
 * neighbours, and between them). Applied to both sides of a "loose" comparison.
 */
function simplify(path: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const t of path) {
    if (t === "C") {
      if (out.length === 0 || out[out.length - 1] !== "C") out.push(t);
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last !== "C" && last[0] === t[0] && last[1] === t[1]) continue;
    const prev = out[out.length - 2];
    if (last !== undefined && last !== "C" && prev !== undefined && prev !== "C") {
      // Is `last` on the segment prev -> t?
      const ax = t[0] - prev[0];
      const ay = t[1] - prev[1];
      const bx = last[0] - prev[0];
      const by = last[1] - prev[1];
      const len = Math.hypot(ax, ay);
      const dot = ax * bx + ay * by;
      if (len > 0 && Math.abs(ax * by - ay * bx) / len <= 1 && dot > 0 && dot < len * len) out.pop();
    }
    out.push(t);
  }
  // Leading/trailing colour markers are not part of the design.
  while (out[0] === "C") out.shift();
  while (out[out.length - 1] === "C") out.pop();
  return out;
}

interface PathCmp {
  /** same: identical; translated: identical after one (dx, dy); differs: anything else. */
  path: "same" | "translated" | "differs";
  dx?: number;
  dy?: number;
  /** Chebyshev distance over aligned needle positions (when the paths have the same shape). */
  maxDelta?: number;
  firstDiff?: number;
  note?: string;
}

function comparePaths(a: Tok[], b: Tok[]): PathCmp {
  const sameShape = a.length === b.length && a.every((t, i) => (t === "C") === (b[i] === "C"));
  if (!sameShape) {
    let i = 0;
    while (i < Math.min(a.length, b.length) && deepEqual(a[i], b[i])) i++;
    const na = a.filter((t) => t !== "C").length;
    const nb = b.filter((t) => t !== "C").length;
    return { path: "differs", firstDiff: i, note: `needles ${na} vs ${nb}, colour changes ${a.length - na} vs ${b.length - nb}` };
  }
  let maxDelta = 0;
  let dx: number | null = null;
  let dy: number | null = null;
  let translated = true;
  let firstDiff = -1;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (p === "C" || q === "C") continue;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    if ((ex !== 0 || ey !== 0) && firstDiff < 0) firstDiff = i;
    maxDelta = Math.max(maxDelta, Math.abs(ex), Math.abs(ey));
    if (dx === null) {
      dx = ex;
      dy = ey;
    } else if (ex !== dx || ey !== dy) translated = false;
  }
  if (maxDelta === 0) return { path: "same" };
  if (translated) return { path: "translated", dx: dx!, dy: dy!, maxDelta, firstDiff };
  return { path: "differs", maxDelta, firstDiff };
}

/** Exact needle paths first; when they differ, the simplified ones ("loose"). */
interface Fidelity {
  cls: "same" | "translated" | "same (loose)" | "translated (loose)" | "differs";
  detail?: string;
  /**
   * The largest coordinate delta between aligned needle points: from the exact paths when they have the same shape,
   * else from the simplified ("loose") paths when those do; absent when neither aligns (then `detail` says how the
   * shapes differ). 0 for same / same (loose).
   */
  maxDelta?: number;
}
function fidelity(a: RefRead, b: RefRead): Fidelity {
  const strict = comparePaths(needlePath(a), needlePath(b));
  if (strict.path === "same") return { cls: "same", maxDelta: 0 };
  if (strict.path === "translated") return { cls: "translated", detail: `(${strict.dx}, ${strict.dy})`, maxDelta: strict.maxDelta };
  const loose = comparePaths(simplify(needlePath(a)), simplify(needlePath(b)));
  if (loose.path === "same") return { cls: "same (loose)", maxDelta: 0 };
  if (loose.path === "translated") return { cls: "translated (loose)", detail: `(${loose.dx}, ${loose.dy})`, maxDelta: loose.maxDelta };
  // Differs: report the delta from whichever comparison could align the paths (exact first, then loose).
  const aligned = strict.maxDelta !== undefined ? { cmp: strict, how: "exact" } : loose.maxDelta !== undefined ? { cmp: loose, how: "loose" } : null;
  if (aligned) {
    return {
      cls: "differs",
      detail: `max delta ${aligned.cmp.maxDelta} from needle #${aligned.cmp.firstDiff} (${aligned.how} paths align)`,
      maxDelta: aligned.cmp.maxDelta,
    };
  }
  return { cls: "differs", detail: `${strict.note}; simplified: ${loose.note}` };
}

const hexes = (d: RefRead): string[] => d.threads.map((t) => (t === null ? "none" : t.color.toLowerCase()));

function colourCmp(p: RefRead, s: RefRead): { colours: string; colourNote?: string } {
  const hp = hexes(p);
  const hs = hexes(s);
  if (hp.length === 0) return { colours: "n/a (pystitch reads none)" };
  if (deepEqual(hp, hs)) return { colours: "same" };
  const n = Math.min(hp.length, hs.length);
  let i = 0;
  while (i < n && hp[i] === hs[i]) i++;
  return { colours: "differ", colourNote: i < n ? `first at ${i}: ${hp[i]} vs ${hs[i]}` : `count ${hp.length} vs ${hs.length}` };
}

interface ThirdCmp {
  identical: boolean;
  path: Fidelity;
  /** Count fields that differ, as "field a/b" (pystitch/third). */
  countDiffs: string[];
  colours: string;
  colourNote?: string;
}

function compareThird(p: RefRead, s: RefRead): ThirdCmp {
  const identical = deepEqual(p.stitches, s.stitches) && deepEqual(hexes(p), hexes(s));
  return { identical, path: fidelity(p, s), countDiffs: countDiffs(p, s), ...colourCmp(p, s) };
}

// ---------------------------------------------------------------- per-file records

interface ReadRow {
  file: string;
  fmt: Fmt;
  py: Counts | { error: string };
  ts: Counts | { error: string };
  /** Null threads in pystitch's reading: None left by JefReader (TS keeps a PlaceholderThread at the same index). */
  pyNoneThreads: number;
  /** TS vs pystitch: "equal", "both-error" or the first difference. */
  tsVsPy: string;
  /** readEmbroidery's verdict (the API's format detection and integrity gate). */
  api: string;
  third: ThirdCmp | { error: string } | "missing";
}

interface WriteCell {
  /**
   * TS vs pystitch bytes: equal | both-error | differ@<offset> (<len>/<len>) | py-error | ts-error, or
   * "py-none-error; vs filled equal|differ…" when pystitch's real writer fails on a None thread in its reading.
   */
  bytes: string;
  /** pystitch's error in the py-none-error case. */
  pyNoneError?: string;
  /** The third engine's write of this source in this format: ok, missing, or its error. */
  third: string;
  /** Its written file read three ways. */
  readback?: ReadRow;
  /** pystitch's reading of the third engine's file vs the third engine's reading of the source. */
  thirdFidelity?: Fidelity & { colours: string };
  /** pystitch's reading of pystitch's own file vs pystitch's reading of the source (reference). */
  pyFidelity?: Fidelity;
}

interface SourceRow {
  group: string;
  read: ReadRow;
  writes: Partial<Record<Fmt, WriteCell>>;
}

function readRow(path: string, py: PyRead | undefined, third: Read | "missing"): ReadRow {
  const bytes = new Uint8Array(readFileSync(path));
  const ts = tsRead(path, bytes);
  const p = py?.dump ?? { error: "no pystitch result" };
  const none = nullThreads(py?.dump);
  let tsVsPy: string;
  if (isErr(p) && isErr(ts)) tsVsPy = "both-error";
  else if (isErr(p)) tsVsPy = `pystitch error (${p.error}), TS read`;
  else if (isErr(ts)) tsVsPy = `TS error (${ts.error}), pystitch read`;
  else tsVsPy = firstDumpDiff(p, ts) ?? "equal";
  let t: ReadRow["third"];
  if (third === "missing") t = "missing";
  else if (isErr(third)) t = third;
  else if (isErr(p)) t = { error: "pystitch could not read it" };
  else t = compareThird(p, third);
  return {
    file: relative(CORPUS, path),
    fmt: fmtOf(path)!,
    py: isErr(p) ? p : counts(p),
    ts: isErr(ts) ? ts : counts(ts),
    pyNoneThreads: none,
    tsVsPy,
    api: apiVerdict(path, bytes),
    third: t,
  };
}

function loadThird(path: string): Read | "missing" {
  if (!existsSync(path)) return "missing";
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RefRead;
  } catch (e) {
    return { error: errText(e) };
  }
}

/** Where the third engine's files for `src` start (add `.<tag>.json` or `.<tag>.<fmt>`); a path nothing exists at when there is no third engine. */
const thirdBase = (src: string): string => join(THIRD_DIR ?? join(LOCAL, ".no-third-engine"), relative(CORPUS, src));
const thirdFile = (src: string, ext: string): string => `${thirdBase(src)}.${THIRD_TAG}.${ext}`;

/** Simplified needle paths of each source, as pystitch and the third engine read it (for the design check). */
const designPaths = new Map<string, { py: Tok[] | null; third: Tok[] | null }>();

async function processChunk(srcs: string[], scratch: string): Promise<SourceRow[]> {
  // 1. pystitch reads every source and every file the third engine wrote for it.
  const paths: string[] = [];
  for (const s of srcs) {
    paths.push(s);
    for (const f of FORMATS) {
      const w = thirdFile(s, f);
      if (existsSync(w)) paths.push(w);
    }
  }
  const dumps = await pyDump(paths);

  // 2. pystitch writes each source exactly as pystitch read it (a None thread stays None), in each format. Missing
  // threads are padded with the deterministic filler where pystitch would pick random colours, as the parity tests
  // do. When the reading holds a None, pystitch is also run with the filler in its place ("filled"): that is what
  // the TS writers use for a PlaceholderThread.
  const jobs: string[] = [];
  const pyOut = new Map<string, string>();
  const pyFilledOut = new Map<string, string>();
  srcs.forEach((s, i) => {
    const d = dumps.get(s)?.dump;
    if (!d || isErr(d)) return;
    const data = withFillerThreads(d, { replaceNull: false });
    const filled = nullThreads(d) > 0 ? withFillerThreads(d) : null;
    for (const f of FORMATS) {
      const out = join(scratch, `${i}.${f}`);
      pyOut.set(`${s}|${f}`, out);
      jobs.push(JSON.stringify({ data, out }));
      if (filled) {
        const outFilled = join(scratch, `${i}.filled.${f}`);
        pyFilledOut.set(`${s}|${f}`, outFilled);
        jobs.push(JSON.stringify({ data: filled, out: outFilled }));
      }
    }
  });
  const writeRes = new Map<string, string>();
  for (const r of await runPy("write", jobs)) writeRes.set(r.out as string, r.error !== undefined ? (r.error as string) : "ok");
  const sameBytes = (path: string, ts: Uint8Array): string => {
    const py = new Uint8Array(readFileSync(path));
    let i = 0;
    const n = Math.min(py.length, ts.length);
    while (i < n && py[i] === ts[i]) i++;
    return i === n && py.length === ts.length ? "equal" : `differ@${i} (${py.length}/${ts.length})`;
  };
  const pyWritten = await pyDump([...writeRes.entries()].filter(([, v]) => v === "ok").map(([k]) => k));

  // 3. Compare.
  const rows: SourceRow[] = [];
  for (const s of srcs) {
    const thirdSrc = loadThird(thirdFile(s, "json"));
    const pySrc = dumps.get(s)?.dump;
    const read = readRow(s, dumps.get(s), thirdSrc);
    const row: SourceRow = { group: groupOf(s), read, writes: {} };
    const key = designKey(s);
    if (key !== null) {
      designPaths.set(s, {
        py: pySrc && !isErr(pySrc) ? simplify(needlePath(pySrc)) : null,
        third: thirdSrc !== "missing" && !isErr(thirdSrc) ? simplify(needlePath(thirdSrc)) : null,
      });
    }
    const tsSrc = tsRead(s, new Uint8Array(readFileSync(s)));
    for (const f of FORMATS) {
      const cell: WriteCell = { bytes: "", third: "missing" };
      // TS writes what TS read (a PlaceholderThread where pystitch has None), padded like pystitch's input.
      let tsBytes: Uint8Array | { error: string };
      if (isErr(tsSrc)) tsBytes = { error: "TS could not read the source" };
      else {
        try {
          tsBytes = tsWrite(fromJson(withFillerThreads(tsSrc, { replaceNull: false })), f);
        } catch (e) {
          tsBytes = { error: errText(e) };
        }
      }
      const outPath = pyOut.get(`${s}|${f}`);
      const pyRes = outPath ? writeRes.get(outPath) ?? "not run" : "pystitch could not read the source";
      const filledPath = pyFilledOut.get(`${s}|${f}`);
      if (pyRes !== "ok" && filledPath !== undefined) {
        // pystitch's own writer fails on the None thread in its reading. The reference is then pystitch given the
        // filler in its place (what TS writes for its placeholder): TS must match it, or fail where it fails too.
        cell.pyNoneError = pyRes;
        const filledRes = writeRes.get(filledPath) ?? "not run";
        if (filledRes === "ok") {
          cell.bytes = `py-none-error; vs filled ${isErr(tsBytes) ? `ts-error (${tsBytes.error})` : sameBytes(filledPath, tsBytes)}`;
        } else {
          cell.bytes = isErr(tsBytes) ? "both-error" : `py-error (with the filler too: ${filledRes})`;
        }
      } else if (pyRes !== "ok" && isErr(tsBytes)) cell.bytes = "both-error";
      else if (pyRes !== "ok") cell.bytes = `py-error (${pyRes})`;
      else if (isErr(tsBytes)) cell.bytes = `ts-error (${tsBytes.error})`;
      else cell.bytes = sameBytes(outPath!, tsBytes);
      if (outPath && pyRes === "ok" && pySrc && !isErr(pySrc)) {
        const back = pyWritten.get(outPath)?.dump;
        if (back && !isErr(back)) cell.pyFidelity = fidelity(pySrc, back);
      }
      // The third engine's file for this format.
      const skFile = thirdFile(s, f);
      if (existsSync(skFile)) {
        cell.third = "ok";
        cell.readback = readRow(skFile, dumps.get(skFile), loadThird(`${skFile}.${THIRD_TAG}.json`));
        const back = dumps.get(skFile)?.dump;
        if (thirdSrc !== "missing" && !isErr(thirdSrc) && back && !isErr(back)) {
          const c = colourCmp(thirdSrc, back);
          cell.thirdFidelity = { ...fidelity(thirdSrc, back), colours: c.colours + (c.colourNote ? ` (${c.colourNote})` : "") };
        }
      }
      row.writes[f] = cell;
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- the same design in several formats

/**
 * Do two needle paths draw the same picture? Both are shifted so their bounding boxes start at (0, 0); then every
 * needle point of each must lie within TOL units of a needle point of the other. Order, extra tie-in points that
 * fall on the design, and splits are ignored. "mirrored y" when that holds only after flipping one upside down.
 */
const TOL = 3;
function pointsOf(path: Tok[], flipY = false): Array<[number, number]> {
  const pts = path.filter((t): t is [number, number] => t !== "C").map(([x, y]): [number, number] => [x, flipY ? -y : y]);
  if (pts.length === 0) return pts;
  let mx = Infinity;
  let my = Infinity;
  for (const [x, y] of pts) {
    mx = Math.min(mx, x);
    my = Math.min(my, y);
  }
  return pts.map(([x, y]): [number, number] => [x - mx, y - my]);
}
function outliers(a: Array<[number, number]>, b: Array<[number, number]>): number {
  const grid = new Map<string, Array<[number, number]>>();
  for (const p of b) {
    const k = `${Math.floor(p[0] / TOL)},${Math.floor(p[1] / TOL)}`;
    const cell = grid.get(k);
    if (cell) cell.push(p);
    else grid.set(k, [p]);
  }
  let n = 0;
  for (const [x, y] of a) {
    const cx = Math.floor(x / TOL);
    const cy = Math.floor(y / TOL);
    let hit = false;
    for (let i = -1; i <= 1 && !hit; i++) {
      for (let j = -1; j <= 1 && !hit; j++) {
        for (const q of grid.get(`${cx + i},${cy + j}`) ?? []) {
          if (Math.abs(q[0] - x) <= TOL && Math.abs(q[1] - y) <= TOL) {
            hit = true;
            break;
          }
        }
      }
    }
    if (!hit) n++;
  }
  return n;
}
function samePicture(a: Tok[], b: Tok[]): string {
  const pa = pointsOf(a);
  const pb = pointsOf(b);
  // A few points may be extra penetrations one format adds (e.g. a stitch at each block start).
  const allowed = 2 + Math.floor((pa.length + pb.length) / 100);
  const off = outliers(pa, pb) + outliers(pb, pa);
  if (off <= allowed) return off === 0 ? "same" : `same (${off} extra points)`;
  const mb = pointsOf(b, true);
  const offMirrored = outliers(pa, mb) + outliers(mb, pa);
  if (offMirrored <= allowed) return `mirrored y (${offMirrored} extra points)`;
  return `differs (${off} of ${pa.length + pb.length} points off by more than ${TOL})`;
}

interface DesignRow {
  key: string;
  formats: Fmt[];
  /** Per format: does this reader see the same design (loose, modulo one shift) as it sees in the anchor format? */
  py: Partial<Record<Fmt, string>>;
  third: Partial<Record<Fmt, string>>;
}

function designCheck(srcs: string[]): DesignRow[] {
  const byKey = new Map<string, string[]>();
  for (const s of srcs) {
    const k = designKey(s);
    if (k !== null) byKey.set(k, [...(byKey.get(k) ?? []), s]);
  }
  const rows: DesignRow[] = [];
  for (const [key, files] of byKey) {
    if (files.length < 2) continue;
    const byFmt = new Map(files.map((f) => [fmtOf(f)!, f]));
    // DST and EXP carry absolute moves and no colour/geometry header to misread; DST is the anchor when present.
    const anchor = byFmt.get("dst") ?? byFmt.get("exp") ?? files[0];
    const row: DesignRow = { key: relative(CORPUS, key), formats: [...byFmt.keys()], py: {}, third: {} };
    for (const who of ["py", "third"] as const) {
      const a = designPaths.get(anchor)?.[who];
      for (const [f, file] of byFmt) {
        if (file === anchor) continue;
        const b = designPaths.get(file)?.[who];
        if (!a || !b) {
          row[who][f] = "unreadable";
          continue;
        }
        row[who][f] = samePicture(a, b);
      }
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- report

function thirdClass(t: ReadRow["third"]): string {
  if (t === "missing") return "missing";
  if (isErr(t)) return "error";
  if (t.identical) return "identical";
  return t.path.cls;
}

const READ_CLASSES = ["identical", "same", "translated", "same (loose)", "translated (loose)", "differs", "error", "missing"];
const FID_CLASSES = ["same", "translated", "same (loose)", "translated (loose)", "differs", "n/a"];

function tally(items: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of items) m.set(r, (m.get(r) ?? 0) + 1);
  return m;
}

function table(head: string[], body: Array<Array<string | number>>): string {
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of body) lines.push(`| ${r.join(" | ")} |`);
  return lines.join("\n");
}

function countDiffTable(rs: ReadRow[]): Array<Array<string | number>> {
  const m = new Map<string, number>();
  for (const r of rs) {
    if (r.third === "missing" || isErr(r.third)) continue;
    for (const d of r.third.countDiffs) {
      const [field, ab] = d.split(" ");
      const [a, b] = ab.split("/").map(Number);
      const k = `${r.fmt}|${field}|${b > a ? "3rd more" : "3rd fewer"}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return [...m.entries()].sort().map(([k, v]) => {
    const [f, field, dir] = k.split("|");
    return [f, `${field}: ${dir}`, v];
  });
}

function short(t: ReadRow["third"]): string {
  if (t === "missing" || isErr(t)) return thirdClass(t);
  const bits = [thirdClass(t)];
  if (t.path.detail) bits.push(t.path.detail);
  if (t.countDiffs.length) bits.push(t.countDiffs.join(", "));
  if (t.colours === "differ") bits.push(`colours ${t.colourNote}`);
  return bits.join("; ");
}

interface Verdict {
  readMismatches: number;
  writeMismatches: number;
  banner: string;
}

function report(rows: SourceRow[], designs: DesignRow[], seconds: number): { md: string; verdict: Verdict } {
  const out: string[] = [];
  const srcReads = rows.map((r) => r.read);
  const backReads: ReadRow[] = [];
  for (const r of rows) for (const f of FORMATS) if (r.writes[f]?.readback) backReads.push(r.writes[f]!.readback!);
  const allReads = [...srcReads, ...backReads];
  out.push(HAS_THIRD ? `# Three-way format check (pystitch / TS port / third engine)` : `# Format check (pystitch / TS port)`);
  out.push("");
  out.push(`Generated by \`npx tsx tools/parity/compare3.ts\` in ${seconds.toFixed(0)} s. Units 0.1 mm. "py" = pystitch 1.0.1, "TS" = this port${HAS_THIRD ? `, "3rd" = the third engine's dumps and files (tag "${THIRD_TAG}") in ${relative(ROOT, THIRD_DIR!)}.` : ". No third engine (--third) was given."}`);
  out.push("");
  out.push(`Needle-path classes: **identical** (every record and colour), **same** (same STITCH positions and colour changes; jumps, trims, END or colours may differ), **translated** (same after one shift), **(loose)** (same after dropping repeated penetrations and the in-between points of split long stitches), **differs**.`);
  out.push("");

  out.push(`## Corpus`);
  out.push("");
  const groups = [...new Set(rows.map((r) => r.group))];
  out.push(table(["source", ...FORMATS, "total"], groups.map((g): Array<string | number> => {
    const rs = rows.filter((r) => r.group === g);
    return [g, ...FORMATS.map((f) => rs.filter((r) => r.read.fmt === f).length), rs.length];
  }).concat([["all", ...FORMATS.map((f) => rows.filter((r) => r.read.fmt === f).length), rows.length]])));
  out.push("");
  out.push(HAS_THIRD ? `Files read three ways: ${allReads.length} (${rows.length} sources + ${backReads.length} files the third engine wrote).` : `Files read two ways: ${allReads.length}.`);
  out.push("");

  // TS vs pystitch.
  const withNull = allReads.filter((r) => r.pyNoneThreads > 0);
  const readMis = allReads.filter((r) => r.tsVsPy !== "equal" && r.tsVsPy !== "both-error");
  const writeCells: Array<[string, Fmt, WriteCell]> = [];
  for (const r of rows) for (const f of FORMATS) if (r.writes[f]) writeCells.push([r.read.file, f, r.writes[f]!]);
  const noneErr = writeCells.filter(([, , c]) => c.bytes.startsWith("py-none-error"));
  const noneErrFilledEqual = noneErr.filter(([, , c]) => c.bytes.endsWith("vs filled equal"));
  const writeMis = writeCells.filter(([, , c]) => c.bytes !== "equal" && c.bytes !== "both-error" && !c.bytes.startsWith("py-none-error"));
  // A TS write that differs from pystitch-given-the-filler is a port bug too.
  const noneErrMis = noneErr.filter(([, , c]) => !c.bytes.endsWith("vs filled equal"));
  const nWrites = writeCells.length;
  const byteIdentical = writeCells.filter(([, , c]) => c.bytes === "equal").length;
  const bothRefuse = writeCells.filter(([, , c]) => c.bytes === "both-error").length;
  const writeMismatches = writeMis.length + noneErrMis.length;
  const banner =
    readMis.length + writeMismatches === 0
      ? `TS vs pystitch: OK. 0 read mismatches in ${allReads.length} reads, 0 write mismatches in ${nWrites} writes (${byteIdentical} byte-identical, ${bothRefuse} refused by both, ${noneErr.length} where pystitch's own writer crashes on its None thread).`
      : `TS vs pystitch: FAIL. ${readMis.length} read and ${writeMismatches} write mismatches (bugs in the port; listed under MISMATCHES).`;
  out.push(`## TS vs pystitch`);
  out.push("");
  out.push(`**${banner}**`);
  out.push("");
  out.push(`- Reads compared: ${allReads.length}; identical: ${allReads.filter((r) => r.tsVsPy === "equal").length} (${withNull.length} of them with a null thread: pystitch's None, TS's placeholder at the same index); both refuse: ${allReads.filter((r) => r.tsVsPy === "both-error").length}; **mismatches: ${readMis.length}**`);
  out.push(`- Writes compared (source x format, each side writing its own reading of the source): ${nWrites}; byte-identical: ${byteIdentical}; both refuse: ${bothRefuse}; pystitch's real writer crashes on a None thread in its reading: ${noneErr.length}; **mismatches: ${writeMismatches}**`);
  if (noneErr.length) {
    const errs = [...new Set(noneErr.map(([, , c]) => (c.pyNoneError ?? "").split(":")[0]))].join(", ");
    const fmts = [...new Set(noneErr.map(([, f]) => f))].join(", ");
    out.push("");
    out.push(`**pystitch behaviour, not counted as byte-identical:** ${noneErr.length} writes (targets: ${fmts}) start from a pystitch reading with a None thread (JefReader's unused colour-0 palette entry), and pystitch's own writer raises on it (${errs}). TS writes the deterministic filler colour for that slot. Given that same filler in place of its None, pystitch writes the same bytes as TS in ${noneErrFilledEqual.length} of ${noneErr.length}.`);
  }
  if (readMis.length || writeMismatches) {
    out.push("");
    out.push(`### MISMATCHES (bugs in the port)`);
    out.push("");
    for (const r of readMis) out.push(`- READ ${r.file}: ${r.tsVsPy}`);
    for (const [file, f, c] of [...writeMis, ...noneErrMis]) out.push(`- WRITE ${file} -> ${f}: ${c.bytes}`);
  }
  out.push("");
  out.push(`### readEmbroidery (the API's format detection and integrity gate)`);
  out.push("");
  const apiRows = (rs: ReadRow[], label: string): Array<Array<string | number>> => FORMATS.map((f) => {
    const sub = rs.filter((r) => r.fmt === f);
    const t = tally(sub.map((r) => r.api));
    return [label, f, sub.length, t.get("ok") ?? 0, [...t.entries()].filter(([k]) => k !== "ok").map(([k, v]) => `${k} ${v}`).join(", ") || "-"];
  });
  out.push(table(["files", "format", "n", "accepted", "refused"], [
    ...groups.flatMap((g) => apiRows(srcReads.filter((r) => groupOf(join(CORPUS, r.file)) === g), `sources: ${g}`)),
    ...apiRows(backReads, "third engine's written files"),
  ].filter((r) => r[2] !== 0)));
  out.push("");
  const backRefused = backReads.filter((r) => r.api !== "ok");
  for (const r of backRefused.slice(0, 20)) out.push(`- refused: ${r.file} (${r.api})`);
  out.push("");

  // Third engine reading the sources.
  const byFmt = (rs: ReadRow[], label: (f: Fmt) => string): Array<Array<string | number>> => FORMATS.map((f) => {
    const t = tally(rs.filter((r) => r.fmt === f).map((r) => thirdClass(r.third)));
    return [label(f), ...READ_CLASSES.map((c) => t.get(c) ?? 0)];
  });
  if (HAS_THIRD) {
  out.push(`## Third engine vs pystitch: reading the sources`);
  out.push("");
  out.push(table(["source", "format", ...READ_CLASSES], groups.flatMap((g) =>
    byFmt(srcReads.filter((r) => groupOf(join(CORPUS, r.file)) === g), (f) => `${g} | ${f}`).map((r) => [...String(r[0]).split(" | "), ...r.slice(1)])
      .filter((r) => (r.slice(2) as number[]).some((n) => n > 0)))));
  out.push("");
  out.push(`Count differences (pystitch/3rd), sources:`);
  out.push("");
  out.push(table(["format", "difference", "files"], countDiffTable(srcReads)));
  out.push("");
  out.push(`Colours (sources): ` + FORMATS.map((f) => {
    const t = tally(srcReads.filter((r) => r.fmt === f).map((r) => (r.third === "missing" || isErr(r.third) ? "?" : r.third.colours)));
    return `${f}: ${[...t.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`;
  }).join("; "));
  out.push("");
  }

  // The same design in several formats.
  out.push(`## One design, several formats`);
  out.push("");
  out.push(`${designs.length} designs exist in 2+ formats (same folder and name). For each reader, the needle points it reads from each format are compared with the ones it reads from the DST (else EXP) of that design: both shifted to start at (0, 0), every point within ${TOL} units (${TOL / 10} mm) of a point of the other, allowing 2 + 1% extra points.`);
  out.push("");
  const dTable: Array<Array<string | number>> = [];
  for (const f of FORMATS) {
    for (const who of ["py", "third"] as const) {
      const t = tally(designs.filter((d) => d[who][f] !== undefined).map((d) => d[who][f]!.replace(/ \(.*/, "")));
      if (t.size === 0) continue;
      dTable.push([f, who === "py" ? "pystitch" : "3rd", t.get("same") ?? 0, t.get("mirrored y") ?? 0, t.get("differs") ?? 0, t.get("unreadable") ?? 0]);
    }
  }
  out.push(table(["format", "reader", "same picture as its DST/EXP", "upside down", "differs", "unreadable"], dTable));
  out.push("");

  // The third engine's written files.
  if (HAS_THIRD) {
  out.push(`## The third engine's written files`);
  out.push("");
  out.push(`Its own errors (from manifest.json): ${manifestSummary()}`);
  out.push("");
  out.push(`### Read by pystitch vs read by the third engine`);
  out.push("");
  out.push(table(["written as", ...READ_CLASSES], byFmt(backReads, (f) => f)));
  out.push("");
  out.push(table(["format", "difference", "files"], countDiffTable(backReads)));
  out.push("");
  out.push(`### Does pystitch read the third engine's file as the design the third engine read from the source?`);
  out.push("");
  out.push(`Needle path of pystitch's reading of the written file vs the third engine's reading of the source. For reference, the same check for pystitch's own writer (pystitch's reading of its file vs its reading of the source) is in the second table.`);
  out.push("");
  const fidTable = (pick: (c: WriteCell) => Fidelity | undefined): Array<Array<string | number>> => FORMATS.map((f) => {
    const t = tally(rows.map((r) => {
      const c = r.writes[f];
      const v = c ? pick(c) : undefined;
      return v ? v.cls : "n/a";
    }));
    return [f, ...FID_CLASSES.map((c) => t.get(c) ?? 0)];
  });
  out.push(table(["written as", ...FID_CLASSES], fidTable((c) => c.thirdFidelity)));
  out.push("");
  out.push(table(["pystitch writes", ...FID_CLASSES], fidTable((c) => c.pyFidelity)));
  out.push("");
  out.push(`Colours, third engine's reading of the source vs pystitch's reading of its file: ` + FORMATS.map((f) => {
    const t = tally(rows.map((r) => r.writes[f]?.thirdFidelity?.colours.replace(/ \(.*/, "") ?? "n/a"));
    return `${f}: ${[...t.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`;
  }).join("; "));
  out.push("");
  }

  // Per source.
  out.push(`## Per source`);
  out.push("");
  out.push(HAS_THIRD
    ? `Columns: records py/TS; TS=py read; 3rd vs py read; then per target format: TS=py write bytes ("=" equal) / pystitch's reading of the 3rd engine's file vs the 3rd engine's reading of the source (max delta in 0.1 mm where the needle paths align).`
    : `Columns: records py/TS; TS=py read; then per target format: TS=py write bytes ("=" equal).`);
  out.push("");
  const wshort = (c: WriteCell | undefined): string => {
    if (!c) return "-";
    const b = c.bytes === "equal" ? "=" : c.bytes === "both-error" ? "both-err" : c.bytes === "py-none-error; vs filled equal" ? "py None-err, = filled" : `**${c.bytes}**`;
    if (!HAS_THIRD) return b;
    const f = c.thirdFidelity;
    // "differs" shows how far apart the aligned needle paths are (when they align), not a bare word.
    const t = f
      ? f.cls === "differs"
        ? `differs${f.maxDelta !== undefined ? ` (max delta ${f.maxDelta})` : ""}`
        : f.cls + (f.detail ? ` ${f.detail}` : "")
      : c.third;
    return `${b} / ${t}`;
  };
  out.push(table(["file", "records py/TS", "TS=py", ...(HAS_THIRD ? ["3rd vs py"] : []), ...FORMATS.map((f) => `-> ${f}`)], rows.map((r) => {
    const p = isErr(r.read.py) ? "err" : r.read.py.records;
    const t = isErr(r.read.ts) ? "err" : r.read.ts.records;
    const tp = r.read.tsVsPy === "equal" ? (r.read.pyNoneThreads ? "= (None)" : "=") : `**${r.read.tsVsPy}**`;
    return [r.read.file, `${p}/${t}`, tp, ...(HAS_THIRD ? [short(r.read.third)] : []), ...FORMATS.map((f) => wshort(r.writes[f]))];
  })));
  out.push("");
  return { md: [banner, "", ...out].join("\n"), verdict: { readMismatches: readMis.length, writeMismatches, banner } };
}

function manifestSummary(): string {
  const p = join(THIRD_DIR ?? "", "manifest.json");
  if (!existsSync(p)) return "no manifest.json";
  const m = JSON.parse(readFileSync(p, "utf8")) as { summary?: Record<string, number> };
  return m.summary ? Object.entries(m.summary).map(([k, v]) => `${k} ${v}`).join(", ") : "no summary";
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const t0 = Date.now();
  const limit = option("--limit");
  let srcs = sources();
  if (limit !== undefined) srcs = srcs.slice(0, Number(limit));
  if (THIRD_DIR !== null && !existsSync(THIRD_DIR)) {
    console.error(`--third ${THIRD_DIR} does not exist`);
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "compare3-"));
  const rows: SourceRow[] = [];
  try {
    const CHUNK = 40;
    const chunks: string[][] = [];
    for (let i = 0; i < srcs.length; i += CHUNK) chunks.push(srcs.slice(i, i + CHUNK));
    const workers = Math.max(1, Math.min(6, Math.floor(cpus().length / 2)));
    const results: SourceRow[][] = new Array(chunks.length);
    let next = 0;
    let done = 0;
    await Promise.all(Array.from({ length: workers }, async (_, w) => {
      while (next < chunks.length) {
        const k = next++;
        const sub = mkdtempSync(join(scratch, `w${w}-`));
        results[k] = await processChunk(chunks[k], sub);
        rmSync(sub, { recursive: true, force: true });
        done += chunks[k].length;
        process.stderr.write(`\r${done}/${srcs.length} sources`);
      }
    }));
    process.stderr.write("\n");
    for (const r of results) rows.push(...r);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const designs = designCheck(srcs);
  const seconds = (Date.now() - t0) / 1000;
  const { md, verdict } = report(rows, designs, seconds);
  mkdirSync(LOCAL, { recursive: true });
  writeFileSync(join(LOCAL, "compare3-report.md"), md);
  writeFileSync(join(LOCAL, "compare3-results.json"), JSON.stringify({ rows, designs }));
  console.log(md.split("\n## Per source")[0]);
  console.log(`\nFull table: ${relative(ROOT, join(LOCAL, "compare3-report.md"))}; raw: ${relative(ROOT, join(LOCAL, "compare3-results.json"))}`);
  console.log(verdict.banner);
  if (verdict.readMismatches + verdict.writeMismatches > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
