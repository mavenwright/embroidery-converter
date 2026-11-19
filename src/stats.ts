import { COLOR_CHANGE, COMMAND_MASK, END, JUMP, STITCH, TRIM } from "./core/constants";
import type { EmbPattern } from "./core/pattern";
import { FILLER_COLORS } from "./core/thread";

export interface PatternStats {
  /** Bounding-box width in millimetres (design units are 0.1 mm). 0 for an empty pattern. */
  widthMm: number;
  heightMm: number;
  /** Number of STITCH commands (not jumps, trims, colour changes or END). */
  stitches: number;
  /**
   * Number of colour blocks that contain at least one STITCH (empty blocks from trailing or consecutive
   * COLOR_CHANGEs are not counted). For DST/EXP, which carry no threads, this is the colour changes + 1
   * for a normal design, not the thread count.
   */
  colors: number;
  /** JUMP commands present after reading (a trim encoded as jumps counts as jumps). */
  jumps: number;
  trims: number;
  /** One "#rrggbb" per non-empty colour block, in order (thread/filler chosen by the original block index); deterministic FILLER_COLORS where threads are missing. */
  colorList: string[];
}

/** "#rrggbb" of a colour, ignoring any alpha byte (PES threads carry 0xFF). */
export function hex6(color: number): string {
  return "#" + (color & 0xffffff).toString(16).padStart(6, "0");
}

/** Colour of colour block `index`: the pattern's thread if it has one, else FILLER_COLORS[index]. */
export function blockColor(p: EmbPattern, index: number): number {
  const t = p.threads[index];
  return (t ? t.color : FILLER_COLORS[index % FILLER_COLORS.length]) & 0xffffff;
}

/**
 * Bounds [minX, minY, maxX, maxY] of the STITCH points only, up to the first END; null if there are none.
 * Lead-in/trailing jumps, trims and colour changes (often at 0,0) must not inflate the design size.
 */
export function stitchBounds(p: EmbPattern): [number, number, number, number] | null {
  const st = p.stitches;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < st.length; i++) {
    const s = st[i];
    const c = s[2] & COMMAND_MASK;
    if (c === END) break;
    if (c !== STITCH) continue;
    const x = s[0], y = s[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

/** Counting stops at the first END, as the writers treat it as the end of the design. */
export function computeStats(p: EmbPattern): PatternStats {
  const st = p.stitches;
  const b = stitchBounds(p);
  if (!b) return { widthMm: 0, heightMm: 0, stitches: 0, colors: 0, jumps: 0, trims: 0, colorList: [] };
  let jumps = 0, trims = 0, stitches = 0, block = 0, blockHas = false;
  const colorList: string[] = [];
  for (let i = 0; i < st.length; i++) {
    const c = st[i][2] & COMMAND_MASK;
    if (c === END) break;
    if (c === STITCH) {
      stitches++;
      if (!blockHas) { blockHas = true; colorList.push(hex6(blockColor(p, block))); }
    } else if (c === JUMP) jumps++;
    else if (c === TRIM) trims++;
    else if (c === COLOR_CHANGE) { block++; blockHas = false; }
  }
  return { widthMm: (b[2] - b[0]) / 10, heightMm: (b[3] - b[1]) / 10, stitches, colors: colorList.length, jumps, trims, colorList };
}
