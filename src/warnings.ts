// Conversion warnings: what the target format cannot keep. Messages are plain English and translation-ready.
import { COLOR_CHANGE, COLOR_BREAK, COMMAND_MASK, NEEDLE_AT, NEEDLE_SET, SEW_TO, STITCH, STOP } from "./core/constants";
import { normalize } from "./core/encoder";
import type { EmbPattern } from "./core/pattern";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings } from "./core/settings";
import { findNearestColorIndex, isPlaceholder, pyRound, type Palette } from "./core/thread";
import type { Format } from "./detect";
import { getThreadSet as jefThreadSet } from "./threads/jef";
import { getThreadSet as pecThreadSet } from "./threads/pec";

export type WarningCode = "colors_dropped" | "exceeds_hoop" | "palette_approximated" | "many_colors" | "stops_dropped";
export interface Warning {
  code: WarningCode;
  message: string;
}

/** User-facing text, one entry per code. Placeholders: {format}, {colors}, {palette}, {size}. */
export const WARNING_MESSAGES: Readonly<Record<WarningCode, string>> = Object.freeze({
  colors_dropped:
    "{format} files don't store thread colours. Your machine will ask for colour changes, but the colours will be lost.",
  palette_approximated:
    "{format} files use a fixed thread palette, so some of your colours were matched to the nearest palette colour.",
  many_colors:
    "This design uses {colors} different colours but {format} only has {palette} thread colours, so some colours will repeat.",
  exceeds_hoop: "{detail}",
  stops_dropped:
    "{format} files can't store stops, so the pause for placing applique fabric will be lost. Convert to PES, DST or JEF instead, or add the stop on your machine.",
});

/**
 * Targets whose pystitch writer drops STOP commands. Checked by writing a pattern with a stop with each pystitch
 * writer and reading it back: PES and JEF keep it as a stop, DST and EXP as a colour change (a machine stop), and
 * Vp3Writer skips it (`elif flags == STOP: continue`).
 */
const DROPS_STOPS: ReadonlySet<Format> = new Set<Format>(["vp3"]);

/** The exceeds_hoop text per format (the format's hoop logic differs). */
export const HOOP_MESSAGES: Readonly<Record<"pes" | "jef", string>> = Object.freeze({
  pes: "This design is bigger than Brother's standard 130 \u00d7 180 mm (5 \u00d7 7 in) hoop. Check that it fits your machine's hoop.",
  jef: "JEF files can only name hoops up to 200 \u00d7 200 mm, so this file will be marked for the default 110 \u00d7 110 mm hoop. Check that your Janome machine and hoop can take a design this size.",
});

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
}

const NAMES: Record<Format, string> = { pes: "PES", dst: "DST", jef: "JEF", exp: "EXP", vp3: "VP3" };

/**
 * Hoop checks, in 0.1 mm. JEF: get_jef_hoop_size only has a size code strictly below 200 x 200 mm; at or beyond it
 * the file falls back to code 0 (110 x 110). PES: PesWriter centres the design for Brother's standard 130 x 180 mm
 * hoop; a design fits it in either orientation. DST, EXP and VP3 have no hoop concept and no coordinate limit
 * (the encoder splits long moves), so they never warn. Bounds are those of the normalised pattern the writers see.
 */
function exceedsHoop(to: Format, w: number, h: number): boolean {
  // JefWriter rounds the width and height (round half to even) before choosing the hoop code.
  if (to === "jef") return pyRound(w) >= 2000 || pyRound(h) >= 2000;
  if (to === "pes") return Math.max(w, h) > 1800 || Math.min(w, h) > 1300;
  return false;
}

/** Colour blocks: runs of stitching between colour changes (what PEC and VP3 write one thread for). */
export function countColorBlocks(pattern: EmbPattern): number {
  let blocks = 0;
  let init = true;
  for (const s of pattern.stitches) {
    const c = s[2] & COMMAND_MASK;
    if (c === STITCH || c === SEW_TO || c === NEEDLE_AT) {
      if (init) {
        blocks++;
        init = false;
      }
    } else if (c === COLOR_CHANGE || c === COLOR_BREAK || c === NEEDLE_SET || c === STOP) {
      init = true;
    }
  }
  return blocks;
}

function paletteOf(to: Format): Palette | null {
  if (to === "jef") return jefThreadSet();
  if (to === "pes") return pecThreadSet();
  return null;
}

export function conversionWarnings(pattern: EmbPattern, to: Format): Warning[] {
  const out: Warning[] = [];
  const name = NAMES[to];
  const add = (code: WarningCode, values: Record<string, string | number> = {}): void => {
    out.push({ code, message: fill(WARNING_MESSAGES[code], { format: name, ...values }) });
  };

  // A PlaceholderThread (a colour slot the file left empty) counts as a missing thread: it is not a user colour.
  const realThreads = pattern.threads.filter((t) => !isPlaceholder(t));
  if ((to === "dst" || to === "exp") && realThreads.length > 0) add("colors_dropped");

  if (DROPS_STOPS.has(to) && pattern.stitches.some((s) => (s[2] & COMMAND_MASK) === STOP)) add("stops_dropped");

  const palette = paletteOf(to);
  if (palette !== null) {
    const entries = palette.filter((p) => p !== null) as Array<{ color: number }>;
    const approximated = realThreads.some((t) => {
      const idx = findNearestColorIndex(t, palette);
      if (idx === null) return false;
      const p = palette[idx] as { color: number };
      return (p.color & 0xffffff) !== (t.color & 0xffffff);
    });
    if (approximated) add("palette_approximated");
    // Distinct colours (alpha masked) among the threads the design actually uses.
    const blocks = countColorBlocks(pattern);
    const used = new Set(
      pattern.threads.slice(0, Math.max(blocks, 1)).filter((t) => !isPlaceholder(t)).map((t) => t.color & 0xffffff),
    );
    if (used.size > entries.length) add("many_colors", { colors: used.size, palette: entries.length });
  }

  if ((to === "jef" || to === "pes") && pattern.stitches.length > 0) {
    // The bounds the writer sees: the normalised pattern (which starts at the origin and has its long moves split).
    let bounds = pattern.bounds();
    try {
      bounds = normalize(pattern, effectiveSettings(to, INKSTITCH_EXPORT_SETTINGS)).bounds();
    } catch {
      /* fall back to the raw bounds */
    }
    const w = bounds[2] - bounds[0];
    const h = bounds[3] - bounds[1];
    if (Number.isFinite(w) && Number.isFinite(h) && exceedsHoop(to, w, h)) out.push({ code: "exceeds_hoop", message: HOOP_MESSAGES[to] });
  }
  return out;
}
