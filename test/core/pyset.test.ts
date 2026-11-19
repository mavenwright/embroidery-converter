// pystitch iterates Python sets (build_unique_palette, get_unique_threadlist), so pySetOrder must reproduce CPython
// 3.12's set iteration order exactly. The real interpreter is the oracle.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pySetOrder } from "../../src/core/pyset";
import { EmbPattern } from "../../src/core/pattern";
import { EmbThread, buildUniquePalette } from "../../src/core/thread";
import { getThreadSet } from "../../src/threads/pec";
import { corpusPath, PYTHON, type RefDump, itPy } from "../helpers/parity";

/** [color, description] per thread. */
type Case = Array<[number, string | null]>;

/** mulberry32: a small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeThreads(c: Case): EmbThread[] {
  return c.map(([color, description]) => {
    const t = new EmbThread();
    t.color = color;
    t.description = description;
    return t;
  });
}

const ORACLE = `
import sys, json
from pystitch.EmbThread import EmbThread, build_unique_palette
from pystitch.EmbThreadPec import get_thread_set
from pystitch import EmbPattern
cases = json.load(sys.stdin)
out = []
for case in cases:
    threads = []
    for color, desc in case:
        t = EmbThread()
        t.color = color
        t.description = desc
        threads.append(t)
    ids = {id(t): i for i, t in enumerate(threads)}
    order = [ids[id(t)] for t in set(threads)]
    p = EmbPattern()
    p.threadlist.extend(threads)
    unique = [ids[id(t)] for t in p.get_unique_threadlist()]
    palette = build_unique_palette(get_thread_set(), threads) if len(threads) <= 300 else None
    out.append({"order": order, "colors": [t.color for t in set(threads)], "unique": unique, "palette": palette})
print(json.dumps(out))
`;

interface OracleResult {
  order: number[];
  colors: number[];
  unique: number[];
  palette: Array<number | null> | null;
}

function oracle(cases: Case[]): OracleResult[] {
  const out = execFileSync(PYTHON, ["-c", ORACLE], { input: JSON.stringify(cases), maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(out.toString("utf8")) as OracleResult[];
}

function cases(): Array<{ label: string; c: Case }> {
  const all: Array<{ label: string; c: Case }> = [];
  const r = rng(20261117);
  // Random colours with duplicates (same object colour+description, and same colour with another description).
  for (let size = 1; size <= 200; size++) {
    const c: Case = [];
    for (let i = 0; i < size; i++) {
      const roll = r();
      if (c.length > 0 && roll < 0.25) {
        c.push(c[Math.floor(r() * c.length)]); // equal thread: deduplicated, first one kept
      } else if (c.length > 0 && roll < 0.35) {
        c.push([c[Math.floor(r() * c.length)][0], `other ${i}`]); // equal hash, not equal
      } else if (roll < 0.45) {
        c.push([Math.floor(r() * 16) * 0x10101, null]); // a small pool: grey levels
      } else {
        c.push([Math.floor(r() * 0x1000000), r() < 0.5 ? null : `t${i}`]);
      }
    }
    all.push({ label: `random size ${size}`, c });
  }
  // Hashes that collide modulo the table sizes, to exercise linear probing and perturbation.
  for (const m of [8, 16, 32, 64, 128, 256, 1024, 0x10000]) {
    for (const n of [3, 6, 9, 12, 20, 40, 75]) {
      const c: Case = [];
      for (let k = 0; k < n; k++) c.push([k * m, null]);
      for (let k = 0; k < n; k += 3) c.push([k * m, null]); // duplicates
      for (let k = 0; k < n; k += 4) c.push([k * m, "x"]); // same hash, different thread
      all.push({ label: `collisions mod ${m} x${n}`, c });
    }
  }
  // Black (hash 0) and alpha bits above 24 (hash masks them).
  all.push({ label: "black and alpha", c: [[0, null], [0xff000000, null], [0, "b"], [0xff000000 + 0xd62828, null], [0xd62828, null], [0, null]] });
  // The colors120 corpus thread list.
  const json = JSON.parse(readFileSync(corpusPath("colors120", "json"), "utf8")) as RefDump;
  all.push({ label: "colors120", c: json.threads.map((t): [number, string | null] => [parseInt(t.color.slice(1), 16), t.description]) });
  // Bigger sets: several resizes, and a resize at 78644 used entries, above 50000 (resize to used*2).
  for (const size of [1000, 3000, 80000]) {
    const c: Case = [];
    for (let i = 0; i < size; i++) c.push([(i * 2654435761) % 0x1000000, null]);
    all.push({ label: `distinct ${size}`, c });
  }
  return all;
}

describe("pySetOrder (CPython 3.12 set iteration order)", () => {
  it("keeps the first of equal items and drops nothing else", () => {
    const a = { k: 1, n: "a" };
    const b = { k: 1, n: "b" };
    const c = { k: 9, n: "c" };
    const order = pySetOrder([a, b, c, a], (x) => x.k, (x, y) => x === y);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set([a, b, c]));
    expect(pySetOrder([a, { ...a }], (x) => x.k, (x, y) => x.n === y.n)).toEqual([a]);
  });

  it("rejects hashes outside 0..2^53 (Python's hash of other ints is not modelled)", () => {
    expect(() => pySetOrder([1], () => -1, () => false)).toThrow(RangeError);
    expect(() => pySetOrder([1], () => 0.5, () => false)).toThrow(RangeError);
  });

  itPy("orders EmbThreads exactly as python's set(threads) does (live oracle)", () => {
    const all = cases();
    const expected = oracle(all.map((x) => x.c));
    for (let n = 0; n < all.length; n++) {
      const threads = makeThreads(all[n].c);
      const order = pySetOrder(threads, (t) => t.hash(), (a, b) => a.equals(b)).map((t) => threads.indexOf(t));
      expect(order, all[n].label).toEqual(expected[n].order);
      expect(order.map((i) => threads[i].color), all[n].label).toEqual(expected[n].colors);
    }
  }, 60_000);

  itPy("get_unique_threadlist and build_unique_palette follow the set order (live oracle)", () => {
    const all = cases().filter((x) => x.c.length <= 300);
    const expected = oracle(all.map((x) => x.c));
    for (let n = 0; n < all.length; n++) {
      const threads = makeThreads(all[n].c);
      const p = new EmbPattern();
      p.threads.push(...threads);
      expect(p.getUniqueThreadlist().map((t) => threads.indexOf(t)), all[n].label).toEqual(expected[n].unique);
      expect(buildUniquePalette(getThreadSet(), threads), all[n].label).toEqual(expected[n].palette);
    }
  }, 60_000);
});
