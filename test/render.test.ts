import { describe, expect, it } from "vitest";
import { EmbPattern, EmbThread, computeStats, renderPattern, readEmbroidery, type RenderContext } from "../src/index";
import { JUMP, TRIM, COLOR_CHANGE, STITCH } from "../src/core/constants";
import { FILLER_COLORS } from "../src/core/thread";
import { readFileSync } from "node:fs";
import { corpusPath, fromJson, type RefDump } from "./helpers/parity";

type Call = [string, ...number[]];
function fakeCtx() {
  const calls: Call[] = [];
  const styles: string[] = [];
  const fills: string[] = [];
  let strokeStyle = "";
  let fillStyle = "";
  const ctx: RenderContext = {
    set strokeStyle(v: string) { strokeStyle = v; styles.push(v); },
    get strokeStyle() { return strokeStyle; },
    set fillStyle(v: string) { fillStyle = v; },
    get fillStyle() { return fillStyle; },
    lineWidth: 1, lineCap: "butt", lineJoin: "miter",
    beginPath() { calls.push(["beginPath"]); },
    moveTo(x: number, y: number) { calls.push(["moveTo", x, y]); },
    lineTo(x: number, y: number) { calls.push(["lineTo", x, y]); },
    stroke() { calls.push(["stroke"]); },
    fillRect(x: number, y: number, w: number, h: number) { fills.push(fillStyle); calls.push(["fillRect", x, y, w, h]); },
  };
  return { ctx, calls, styles, fills };
}
const colors3 = (): EmbPattern => fromJson(JSON.parse(readFileSync(corpusPath("colors3", "json"), "utf8")) as RefDump);

describe("computeStats", () => {
  it("colors3 matches the pystitch dump", () => {
    const s = computeStats(colors3());
    expect(s).toEqual({ widthMm: 29, heightMm: 20, stitches: 37, colors: 3, jumps: 0, trims: 0, colorList: ["#d62828", "#1d70b8", "#2a9d3f"] });
  });
  it("masks the PES alpha byte and fills missing colours with FILLER_COLORS", () => {
    const p = new EmbPattern();
    p.addThread(new EmbThread(0xffff0000));
    p.stitchAbs(0, 0); p.colorChange(); p.stitchAbs(10, 0); p.colorChange(); p.stitchAbs(20, 0); p.end();
    const s = computeStats(p);
    expect(s.colors).toBe(3);
    expect(s.colorList).toEqual(["#ff0000", "#" + FILLER_COLORS[1].toString(16).padStart(6, "0"), "#" + FILLER_COLORS[2].toString(16).padStart(6, "0")]);
  });
  it("DST (no threads) counts colour blocks = colour changes + 1", () => {
    const p = readEmbroidery(new Uint8Array(readFileSync(corpusPath("colors3", "dst"))), "a.dst");
    const s = computeStats(p);
    expect(s.colors).toBe(3);
    expect(s.colorList).toHaveLength(3);
  });
  it("counts jumps and trims from the commands present", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0); p.trim(); p.move(50, 0); p.move(10, 0); p.stitch(5, 0); p.end();
    const s = computeStats(p);
    expect(s.jumps).toBe(2);
    expect(s.trims).toBe(1);
  });
  it("empty pattern: zeros, no throw", () => {
    expect(computeStats(new EmbPattern())).toEqual({ widthMm: 0, heightMm: 0, stitches: 0, colors: 0, jumps: 0, trims: 0, colorList: [] });
  });
  it("stitches counts only STITCH commands", () => {
    const p = new EmbPattern();
    for (let i = 0; i < 5; i++) p.stitchAbs(i * 5, 0);
    p.moveAbs(100, 0); p.moveAbs(110, 0); p.trim(); p.colorChange();
    for (let i = 0; i < 5; i++) p.stitchAbs(200 + i * 5, 0);
    p.end();
    const s = computeStats(p);
    expect(s.stitches).toBe(10);
    expect(s.jumps).toBe(2);
    expect(s.trims).toBe(1);
    expect(s.colors).toBe(2);
  });
  it("trailing and consecutive colour changes add no empty colours, mapping stays by block index", () => {
    const p = new EmbPattern();
    p.addThread(new EmbThread(0xffff0000)); p.addThread(new EmbThread(0x00ff00)); p.addThread(new EmbThread(0x0000ff));
    p.stitchAbs(0, 0); p.stitchAbs(5, 0);
    p.colorChange(); p.colorChange(); // block 1 empty
    p.stitchAbs(10, 0); p.stitchAbs(15, 0); // block 2
    p.colorChange(); // trailing empty block 3
    p.end();
    const s = computeStats(p);
    expect(s.colors).toBe(2);
    expect(s.colorList).toEqual(["#ff0000", "#0000ff"]);
  });
  it("size comes from STITCH points only (lead-in jump at origin ignored)", () => {
    const p = new EmbPattern();
    p.moveAbs(0, 0);
    p.stitchAbs(1000, 1000); p.stitchAbs(1300, 1200);
    p.trim(); p.colorChange(); p.end();
    const s = computeStats(p);
    expect(s.widthMm).toBe(30);
    expect(s.heightMm).toBe(20);
  });
  it("no STITCH commands gives 0 x 0", () => {
    const p = new EmbPattern(); p.moveAbs(50, 50); p.moveAbs(900, 900); p.end();
    const s = computeStats(p);
    expect([s.widthMm, s.heightMm, s.stitches, s.colors]).toEqual([0, 0, 0, 0]);
  });
  it("stops counting at the first END", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0); p.stitchAbs(10, 0); p.end();
    p.stitchAbs(5000, 0); p.moveAbs(6000, 0);
    const s = computeStats(p);
    expect(s.stitches).toBe(2);
    expect(s.jumps).toBe(0);
    expect(s.widthMm).toBe(1);
  });
});

describe("renderPattern", () => {
  it("colors3 uses 3 distinct strokeStyle values, one stroke per block", () => {
    const { ctx, calls, styles } = fakeCtx();
    renderPattern(colors3(), ctx, { width: 300, height: 200 });
    expect(new Set(styles).size).toBe(3);
    expect(styles).toEqual(["#d62828", "#1d70b8", "#2a9d3f"]);
    expect(calls.filter((c) => c[0] === "stroke")).toHaveLength(3);
  });
  it("never draws a line across a JUMP, TRIM or COLOR_CHANGE when showJumps=false", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0); p.stitchAbs(10, 0); p.moveAbs(100, 100); p.stitchAbs(110, 100); p.trim(); p.moveAbs(200, 0); p.stitchAbs(210, 0);
    p.colorChange(); p.moveAbs(0, 50); p.stitchAbs(10, 50); p.end();
    const { ctx, calls } = fakeCtx();
    renderPattern(p, ctx, { width: 400, height: 200 });
    // Reconstruct segments and make sure each lineTo starts at the previous point of a STITCH pair.
    let pos: [number, number] | null = null;
    const segs: [number, number, number, number][] = [];
    for (const c of calls) {
      if (c[0] === "moveTo") pos = [c[1], c[2]];
      if (c[0] === "lineTo") { segs.push([pos![0], pos![1], c[1], c[2]]); pos = [c[1], c[2]]; }
    }
    expect(segs).toHaveLength(4);
    // Longest segment is just a stitch (10 units), a jump would be >= 90 units.
    const lens = segs.map((s) => Math.hypot(s[2] - s[0], s[3] - s[1]));
    expect(Math.max(...lens) / Math.min(...lens)).toBeCloseTo(1, 5);
  });
  it("showJumps draws jumps in a separate pass with a different strokeStyle", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0); p.stitchAbs(10, 0); p.moveAbs(100, 0); p.stitchAbs(110, 0); p.end();
    const a = fakeCtx(); renderPattern(p, a.ctx, { width: 300, height: 100 });
    const b = fakeCtx(); renderPattern(p, b.ctx, { width: 300, height: 100, showJumps: true });
    expect(b.calls.filter((c) => c[0] === "lineTo").length).toBe(a.calls.filter((c) => c[0] === "lineTo").length + 1);
    expect(b.styles.length).toBe(a.styles.length + 1);
  });
  it("fits and centres preserving aspect ratio inside the box, dpr scales", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0); p.stitchAbs(100, 0); p.stitchAbs(100, 50); p.end();
    for (const dpr of [1, 2]) {
      const { ctx, calls } = fakeCtx();
      renderPattern(p, ctx, { width: 200, height: 200, dpr });
      const pts = calls.filter((c) => c[0] === "moveTo" || c[0] === "lineTo") as [string, number, number][];
      const xs = pts.map((c) => c[1]); const ys = pts.map((c) => c[2]);
      const W = 200 * dpr;
      expect(Math.min(...xs)).toBeGreaterThan(0);
      expect(Math.max(...xs)).toBeLessThan(W);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(W / 2, 5);
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(W / 2, 5);
      expect((Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))).toBeCloseTo(2, 5);
    }
  });
  it("line width is at least 0.5 px", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0); p.stitchAbs(100000, 0); p.end();
    const { ctx } = fakeCtx();
    renderPattern(p, ctx, { width: 100, height: 100 });
    expect(ctx.lineWidth).toBeGreaterThanOrEqual(0.5);
  });
  it("empty pattern paints only the background and does not throw", () => {
    const { ctx, calls, fills } = fakeCtx();
    renderPattern(new EmbPattern(), ctx, { width: 100, height: 80, background: "#ffffff" });
    expect(calls.filter((c) => c[0] !== "fillRect")).toEqual([]);
    expect(fills).toEqual(["#ffffff"]);
  });
  it("a single stitch / zero-extent pattern does not produce NaN", () => {
    const p = new EmbPattern(); p.stitchAbs(5, 5); p.end();
    const { ctx, calls } = fakeCtx();
    renderPattern(p, ctx, { width: 100, height: 100 });
    for (const c of calls) for (const n of c.slice(1)) expect(Number.isFinite(n as number)).toBe(true);
  });
  it("renders a 500k-stitch pattern in under 1.5 s", () => {
    const p = new EmbPattern();
    p.addThread(new EmbThread(0x112233));
    for (let i = 0; i < 500_000; i++) {
      p.stitchAbs((i % 1000) * 3, Math.floor(i / 1000) * 3 + (i % 2));
      if (i % 50_000 === 49_999) p.colorChange();
    }
    p.end();
    const { ctx } = fakeCtx();
    const t = performance.now();
    renderPattern(p, ctx, { width: 800, height: 600, dpr: 2, showJumps: true });
    expect(performance.now() - t).toBeLessThan(1500);
    expect(computeStats(p).stitches).toBe(500_000);
  });
  it("a lead-in jump at the origin does not shrink or shift the drawn stitches", () => {
    const p = new EmbPattern();
    p.moveAbs(0, 0);
    p.stitchAbs(1000, 1000); p.stitchAbs(1100, 1000); p.stitchAbs(1100, 1050); p.end();
    const { ctx, calls } = fakeCtx();
    renderPattern(p, ctx, { width: 200, height: 200 });
    const pts = calls.filter((c) => c[0] === "moveTo" || c[0] === "lineTo") as [string, number, number][];
    const xs = pts.map((c) => c[1]); const ys = pts.map((c) => c[2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(200 - 12, 5);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(100, 5);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(100, 5);
  });
  it("a pattern with no STITCH commands paints only the background", () => {
    const p = new EmbPattern(); p.moveAbs(0, 0); p.moveAbs(100, 100); p.end();
    const { ctx, calls } = fakeCtx();
    renderPattern(p, ctx, { width: 100, height: 100, background: "#fff", showJumps: true });
    expect(calls.filter((c) => c[0] !== "fillRect")).toEqual([]);
  });
  it("stops drawing at the first END", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0); p.stitchAbs(10, 0); p.end(); p.stitchAbs(5000, 0); p.stitchAbs(5010, 0);
    const { ctx, calls } = fakeCtx();
    renderPattern(p, ctx, { width: 200, height: 100 });
    expect(calls.filter((c) => c[0] === "lineTo")).toHaveLength(1);
  });
  it("line width follows the scale: 0.4 mm, clamped to 0.5..3 px per dpr", () => {
    const mk = (len: number) => { const p = new EmbPattern(); p.stitchAbs(0, 0); p.stitchAbs(len, 0); p.end(); return p; };
    const w = (len: number, dpr = 1) => { const { ctx } = fakeCtx(); renderPattern(mk(len), ctx, { width: 200, height: 200, dpr }); return ctx.lineWidth; };
    // 100 units across 188 px => scale 1.88 => 0.4 mm = 7.5 px, clamped to 3
    expect(w(100)).toBe(3);
    expect(w(100, 2)).toBe(6);
    // 1000 units => scale 0.188 => 0.75 px, unclamped
    expect(w(1000)).toBeCloseTo(0.752, 3);
    // 100000 units => clamped to 0.5
    expect(w(100000)).toBe(0.5);
  });
  it("keeps constants referenced", () => { expect([JUMP, TRIM, COLOR_CHANGE, STITCH]).toHaveLength(4); });
});
