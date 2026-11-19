import { COLOR_CHANGE, COMMAND_MASK, END, JUMP, STITCH, TRIM } from "./core/constants";
import type { EmbPattern } from "./core/pattern";
import { blockColor, hex6, stitchBounds } from "./stats";

/** The subset of CanvasRenderingContext2D used, so Node tests need no DOM. */
export interface RenderContext {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  setLineDash?(segments: number[]): void;
  setTransform?(a: number, b: number, c: number, d: number, e: number, f: number): void;
  canvas?: { width: number; height: number };
}

export interface RenderOptions {
  /** Size in CSS pixels. The backing store is width*dpr by height*dpr. */
  width: number;
  height: number;
  background?: string;
  /** Draw jumps/trims as a thin dashed grey line, in a separate pass after the stitches. */
  showJumps?: boolean;
  dpr?: number;
}

const THREAD_UNITS = 4; // 0.4 mm in 0.1 mm design units
const MIN_LINE_PX = 0.5; // per dpr
const MAX_LINE_PX = 3; // per dpr
const MARGIN_CSS = 6;
const JUMP_STYLE = "rgba(110,110,110,0.55)";

/**
 * Draws the pattern scaled to fit, centred, Y axis as stored (down). One path and one strokeStyle per
 * colour block; every non-STITCH command starts a new subpath, so no line crosses a jump, trim, stop
 * or colour change. Jumps (showJumps) are drawn afterwards in one dashed grey path. Fit uses STITCH
 * points only (up to the first END), so jumps outside the stitch extents (e.g. a lead-in from 0,0) may
 * fall off-canvas and are simply clipped by the canvas.
 */
export function renderPattern(p: EmbPattern, ctx: RenderContext, opts: RenderOptions): void {
  const dpr = opts.dpr && opts.dpr > 0 ? opts.dpr : 1;
  const W = Math.max(1, Math.round(opts.width * dpr));
  const H = Math.max(1, Math.round(opts.height * dpr));
  if (ctx.canvas) { ctx.canvas.width = W; ctx.canvas.height = H; }
  ctx.setTransform?.(1, 0, 0, 1, 0, 0);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, W, H);
  }
  const st = p.stitches;
  const bounds = stitchBounds(p);
  if (!bounds) return; // no STITCH commands: background only
  const [minX, minY, maxX, maxY] = bounds;
  // Stop at the first END, like the writers.
  let n = st.length;
  for (let i = 0; i < st.length; i++) if ((st[i][2] & COMMAND_MASK) === END) { n = i; break; }

  const margin = MARGIN_CSS * dpr;
  const availW = Math.max(1, W - 2 * margin);
  const availH = Math.max(1, H - 2 * margin);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min(availW / spanX, availH / spanY);
  const ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (H - (maxY - minY) * scale) / 2 - minY * scale;

  const threadPx = Math.min(Math.max(THREAD_UNITS * scale, MIN_LINE_PX * dpr), MAX_LINE_PX * dpr);
  ctx.lineWidth = threadPx;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash?.([]);

  let block = 0;
  let pathOpen = false; // beginPath issued for this block
  let styled = false; // strokeStyle set for this block
  let penKnown = false; // a current point exists in the open subpath
  let seenStitch = false;
  let havePend = false; // position of the last non-stitch command, where the next stitch starts
  let pendX = 0, pendY = 0;
  for (let i = 0; i < n; i++) {
    const s = st[i];
    const cmd = s[2] & COMMAND_MASK;
    const x = s[0] * scale + ox;
    const y = s[1] * scale + oy;
    if (cmd === STITCH) {
      seenStitch = true;
      if (!styled) {
        ctx.strokeStyle = hex6(blockColor(p, block));
        styled = true;
      }
      if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
      if (penKnown) ctx.lineTo(x, y);
      else {
        // New subpath. Needles arrive at a stitch from the preceding jump/colour-change position.
        if (havePend) { ctx.moveTo(pendX, pendY); ctx.lineTo(x, y); } else ctx.moveTo(x, y);
        penKnown = true;
      }
    } else {
      if (cmd === COLOR_CHANGE) {
        if (pathOpen) ctx.stroke();
        pathOpen = false; styled = false;
        block++;
      }
      // JUMP / TRIM / STOP / COLOR_CHANGE / anything else breaks the line: the next stitch opens a
      // new subpath (moveTo) starting at this command's position, so nothing is drawn across it.
      penKnown = false;
      // Lead-in commands before the first stitch (often at 0,0) sew nothing, so they set no start point.
      if (seenStitch) { havePend = true; pendX = x; pendY = y; }
    }
  }
  if (pathOpen) ctx.stroke();

  if (opts.showJumps) {
    ctx.strokeStyle = JUMP_STYLE;
    ctx.lineWidth = Math.max(threadPx / 2, MIN_LINE_PX * dpr);
    ctx.setLineDash?.([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    let px = 0, py = 0, have = false;
    for (let i = 0; i < n; i++) {
      const s = st[i];
      const cmd = s[2] & COMMAND_MASK;
      const x = s[0] * scale + ox;
      const y = s[1] * scale + oy;
      if ((cmd === JUMP || cmd === TRIM) && have) {
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
      }
      px = x; py = y; have = true;
    }
    ctx.stroke();
    ctx.setLineDash?.([]);
  }
}
