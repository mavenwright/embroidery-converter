// Parity harness: reads pystitch-generated reference files and calls pystitch as the oracle.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { COLOR_CHANGE, COMMAND_MASK, NEEDLE_SET } from "../../src/core/constants";
import { EmbPattern } from "../../src/core/pattern";
import { EmbThread, FILLER_COLORS, PlaceholderThread, isPlaceholder } from "../../src/core/thread";

export interface RefThread {
  color: string; // "#rrggbb"
  description: string | null;
  catalog_number: string | null;
  brand: string | null;
}

/** A pattern as JSON: what the writers are given. */
export interface RefDump {
  stitches: [number, number, number][];
  threads: RefThread[];
  extras: Record<string, string | number | boolean>;
}

/**
 * What a reader produced (dump.py, toRefShape). A thread is null where pystitch's threadlist holds None (JefReader's
 * unused colour-0 entry); the TS readers keep a PlaceholderThread there.
 */
export type RefRead = Omit<RefDump, "threads"> & { threads: Array<RefThread | null> };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SYNTHETIC_DIR = join(ROOT, "corpus", "synthetic");
export const PARITY_DIR = join(ROOT, "tools", "parity");
export const PYTHON = join(PARITY_DIR, ".venv", "bin", "python");
export const WRITE_PY = join(PARITY_DIR, "write.py");
export const DUMP_PY = join(PARITY_DIR, "dump.py");
export const DUMP_MANY_PY = join(PARITY_DIR, "dump_many.py");

/**
 * True when the pystitch virtualenv exists (see tools/parity/README.md). The live-oracle tests need it and are
 * skipped without it; the tests against the committed reference files in corpus/synthetic do not.
 */
export const HAS_PYTHON = existsSync(PYTHON);
/** `it` / `describe` that only run when pystitch is available. */
export const itPy = it.skipIf(!HAS_PYTHON);
export const describePy = describe.skipIf(!HAS_PYTHON);

/**
 * Called by every helper that runs pystitch. A test that reaches it without the virtualenv was not guarded with
 * itPy / describePy; failing loudly keeps "pystitch raises" assertions from passing because Python is missing.
 */
export function requirePython(): void {
  if (!HAS_PYTHON) throw new Error("pystitch virtualenv missing (tools/parity/.venv): guard this test with itPy / describePy");
}
export const LOCAL_DIR = join(ROOT, "corpus", "local");

/** Every file under corpus/local (recursively) with this extension, any case; sorted. Empty when there is none. */
export function localFiles(ext: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\.${ext}$`, "i");
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (re.test(e)) out.push(p);
    }
  };
  walk(LOCAL_DIR);
  return out;
}

/**
 * pystitch's reading of each file as unparsed JSON (dump.py's shape, or {"error": exception name}), from one
 * dump_many.py process. Kept as text so thousands of dumps stay small; parse one with JSON.parse when it is needed.
 */
export function pythonDumpMany(paths: string[]): Map<string, string> {
  if (paths.length === 0) return new Map();
  requirePython();
  const out = execFileSync(PYTHON, [DUMP_MANY_PY, "-"], {
    input: paths.join("\n") + "\n",
    cwd: dirname(DUMP_MANY_PY),
    maxBuffer: 2 * 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const result = new Map<string, string>();
  for (const line of out.toString("utf8").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) result.set(JSON.parse(line.slice(0, tab)) as string, line.slice(tab + 1));
  }
  return result;
}

/** A beforeAll timeout for pythonDumpMany over `n` files: a minute plus 100 ms per file. */
export const dumpManyTimeout = (n: number): number => 60_000 + 100 * n;

/** Path of a corpus file, e.g. corpusPath("colors3", "dst") or corpusPath("colors3", "dst.dump.json"). */
export function corpusPath(name: string, ext: string): string {
  return join(SYNTHETIC_DIR, `${name}.${ext}`);
}

/** The pystitch-written file and pystitch's re-read of it. `ext` may be "v6.pes". */
export function loadReference(name: string, ext: string): { bytes: Uint8Array; dump: RefDump } {
  const bytes = new Uint8Array(readFileSync(corpusPath(name, ext)));
  const dump = JSON.parse(readFileSync(corpusPath(name, `${ext}.dump.json`), "utf8")) as RefDump;
  return { bytes, dump };
}

/** Writes `json` with pystitch (the Ink/Stitch export settings, `extraSettings` merged over them). Throws on failure. */
export function pythonWrite(json: RefRead, ext: string, extraSettings?: Record<string, unknown>): Uint8Array {
  requirePython();
  const dir = mkdtempSync(join(tmpdir(), "parity-"));
  try {
    const input = join(dir, "in.json");
    const output = join(dir, `out.${ext}`);
    writeFileSync(input, JSON.stringify(json));
    const args = [WRITE_PY, input, output];
    if (extraSettings) args.push(JSON.stringify(extraSettings));
    execFileSync(PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
    return new Uint8Array(readFileSync(output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** pystitch's reading of `bytes` saved as a .`ext` file (dump.py), or {error} when pystitch raises. */
export function pythonRead(bytes: Uint8Array, ext: string): RefRead | { error: string } {
  requirePython();
  const dir = mkdtempSync(join(tmpdir(), "parity-"));
  try {
    const path = join(dir, `in.${ext}`);
    writeFileSync(path, bytes);
    const out = execFileSync(PYTHON, [DUMP_PY, path], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(out.toString("utf8")) as RefRead;
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n").slice(-2).join(" ") : String(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A `dump.py --normalized` result: the encoder output plus the settings write_embroidery built. */
export interface NormalizedRef extends RefDump {
  settings: Record<string, unknown>;
}

/** pystitch's get_normalized_pattern for `json` exactly as write.py would encode it for `ext`. Throws on failure. */
export function pythonNormalize(json: RefRead, ext: string, extraSettings?: Record<string, unknown>): NormalizedRef {
  requirePython();
  const dir = mkdtempSync(join(tmpdir(), "parity-"));
  try {
    const input = join(dir, "in.json");
    writeFileSync(input, JSON.stringify(json));
    const args = [DUMP_PY, "--normalized", input, ext];
    if (extraSettings) args.push(JSON.stringify(extraSettings));
    const out = execFileSync(PYTHON, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(out.toString("utf8")) as NormalizedRef;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hex6 = (n: number): string => "#" + (n & 0xffffff).toString(16).padStart(6, "0");

export function fromJson(json: RefRead): EmbPattern {
  const pattern = new EmbPattern();
  for (const [x, y, cmd] of json.stitches) pattern.stitches.push([x, y, cmd]);
  for (const t of json.threads) {
    if (t === null) {
      pattern.threads.push(new PlaceholderThread(pattern.threads.length));
      continue;
    }
    const thread = new EmbThread();
    thread.color = parseInt(t.color.replace(/^#/, ""), 16);
    thread.description = t.description;
    thread.catalogNumber = t.catalog_number;
    thread.brand = t.brand;
    pattern.threads.push(thread);
  }
  Object.assign(pattern.extras, json.extras);
  return pattern;
}

export function toRefShape(pattern: EmbPattern): RefRead {
  const extras: RefDump["extras"] = {};
  for (const [k, v] of Object.entries(pattern.extras)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") extras[k] = v;
  }
  return {
    stitches: pattern.stitches.map((s): [number, number, number] => [s[0], s[1], s[2]]),
    threads: pattern.threads.map((t) =>
      isPlaceholder(t)
        ? null
        : {
            color: hex6(t.color),
            description: t.description,
            catalog_number: t.catalogNumber,
            brand: t.brand,
          },
    ),
    extras,
  };
}

const fillerThread = (i: number): RefThread => ({
  color: hex6(FILLER_COLORS[i % FILLER_COLORS.length]),
  description: "Random",
  catalog_number: null,
  brand: null,
});

/**
 * pystitch fills missing threads with RANDOM colours; the TS port uses FILLER_COLORS. Returns a copy with
 * threads padded to the colour-block count so pystitch and the TS writer see identical threads. A null thread
 * (pystitch's None, TS's PlaceholderThread) becomes the filler for its index too, which is what the TS writers use
 * for it; pystitch's writers would crash on the None. Pass `{ replaceNull: false }` to keep the nulls.
 */
export function withFillerThreads(json: RefRead): RefDump;
export function withFillerThreads(json: RefRead, opts: { replaceNull: boolean }): RefRead;
export function withFillerThreads(json: RefRead, opts: { replaceNull?: boolean } = {}): RefRead {
  let blocks = 0;
  for (const _ of fromJson(json).getAsColorblocks()) blocks++;
  // Writers can request one thread per COLOR_CHANGE / NEEDLE_SET, plus the first.
  let commands = 1;
  for (const s of json.stitches) {
    const c = s[2] & COMMAND_MASK;
    if (c === COLOR_CHANGE || c === NEEDLE_SET) commands++;
  }
  blocks = Math.max(blocks, commands);
  const threads = (opts.replaceNull ?? true) ? json.threads.map((t, i) => t ?? fillerThread(i)) : json.threads.slice();
  for (let i = threads.length; i < blocks; i++) threads.push(fillerThread(i));
  return { ...json, threads };
}
