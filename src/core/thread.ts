// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of EmbThread.py.
import { pySetOrder } from "./pyset";

/** Python's round(): half to even. */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Deterministic filler colours. DELIBERATE, DOCUMENTED DIFFERENCE from pystitch, which uses
 * random.getrandbits(24) for filler threads: output must be reproducible.
 */
export const FILLER_COLORS: readonly number[] = [
  0x0000ff, 0xff0000, 0x00a000, 0xffc000, 0x8000c0, 0x00c0c0, 0xff6000, 0xc00060, 0x606060, 0x804000, 0x0080ff,
  0x80c000,
];

export type ThreadLike = EmbThread | number;
/** Palette entries may be null (already used), as in pystitch. */
export type Palette = Array<EmbThread | number | null>;

export function colorRgb(r: number, g: number, b: number): number {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

/** color_hex: "#rrggbb", "rrggbbaa" (alpha dropped) or 3/4 digit shorthand. Undefined for other lengths. */
export function colorHex(hexString: string): number | undefined {
  const h = hexString.replace(/^#+/, "");
  const size = h.length;
  let digits: string;
  if (size === 6 || size === 8) digits = h.slice(0, 6);
  else if (size === 4 || size === 3) digits = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  else return undefined;
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) throw new Error(`invalid hex colour: ${hexString}`);
  return parseInt(digits, 16);
}

/** color_distance_red_mean: https://www.compuphase.com/cmetric.htm */
export function colorDistanceRedMean(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const redMean = pyRound((r1 + r2) / 2);
  const r = r1 - r2;
  const g = g1 - g2;
  const b = b1 - b2;
  return (((512 + redMean) * r * r) >> 8) + 4 * g * g + (((767 - redMean) * b * b) >> 8);
}

function rgbOf(v: EmbThread | number): [number, number, number] {
  const c = v instanceof EmbThread ? v.color : v;
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}

/** find_nearest_color_index: ties choose the later entry (<=). Null if no entries remain. */
export function findNearestColorIndex(findColor: ThreadLike, values: Palette): number | null {
  const [red, green, blue] = rgbOf(findColor);
  let closestIndex: number | null = null;
  let currentClosestValue = Infinity;
  for (let i = 0; i < values.length; i++) {
    const t = values[i];
    if (t === null || t === undefined) continue;
    const [r, g, b] = rgbOf(t);
    const dist = colorDistanceRedMean(red, green, blue, r, g, b);
    if (dist <= currentClosestValue) {
      currentClosestValue = dist;
      closestIndex = i;
    }
  }
  return closestIndex;
}

/** build_palette */
export function buildPalette(threadPalette: Palette, threadlist: EmbThread[]): Array<number | null> {
  return threadlist.map((t) => t.findNearestColorIndex(threadPalette));
}

/** build_nonrepeat_palette */
export function buildNonrepeatPalette(threadPalette: Palette, threadlist: EmbThread[]): Array<number | null> {
  let lastIndex: number | null = null;
  let lastThread: EmbThread | null = null;
  const palette: Array<number | null> = [];
  for (const thread of threadlist) {
    let index = thread.findNearestColorIndex(threadPalette);
    if (lastIndex === index && !(lastThread !== null && lastThread.equals(thread))) {
      const repeatedIndex = index as number;
      const repeatedThread = threadPalette[repeatedIndex];
      threadPalette[repeatedIndex] = null;
      index = thread.findNearestColorIndex(threadPalette);
      // index will no longer be repeated.
      threadPalette[repeatedIndex] = repeatedThread;
    }
    palette.push(index);
    lastIndex = index;
    lastThread = thread;
  }
  return palette;
}

/** The threads of `threadlist` in the order Python iterates `set(threadlist)` (EmbThread __hash__ and __eq__). */
export function threadSetOrder(threadlist: Iterable<EmbThread>): EmbThread[] {
  return pySetOrder(threadlist, (t) => t.hash(), (a, b) => a.equals(b));
}

/** build_unique_palette. Iterates the unique threads in CPython's set(threadlist) order, as pystitch does. */
export function buildUniquePalette(threadPalette: Palette, threadlist: EmbThread[]): Array<number | null> {
  const chart: Array<EmbThread | null> = new Array(threadPalette.length).fill(null);
  for (const thread of threadSetOrder(threadlist)) {
    // for each unique color, move closest remaining thread to lookup chart.
    const index = thread.findNearestColorIndex(threadPalette);
    if (index === null) break; // No more threads remain in palette
    threadPalette[index] = null; // entries may not be reused.
    chart[index] = thread;
  }
  return threadlist.map((t) => t.findNearestColorIndex(chart));
}

export interface ThreadDict {
  name?: string;
  description?: string;
  desc?: string;
  brand?: string;
  manufacturer?: string;
  chart?: string;
  color?: string | number | number[];
  rgb?: string | number | number[];
  hex?: string;
  id?: string;
  catalog?: string;
}

export type ThreadInput = EmbThread | number | string | ThreadDict;

const COLOR_DICT: Record<string, number> = {
  aliceblue: colorRgb(240, 248, 255),
  antiquewhite: colorRgb(250, 235, 215),
  aqua: colorRgb(0, 255, 255),
  aquamarine: colorRgb(127, 255, 212),
  azure: colorRgb(240, 255, 255),
  beige: colorRgb(245, 245, 220),
  bisque: colorRgb(255, 228, 196),
  black: colorRgb(0, 0, 0),
  blanchedalmond: colorRgb(255, 235, 205),
  blue: colorRgb(0, 0, 255),
  blueviolet: colorRgb(138, 43, 226),
  brown: colorRgb(165, 42, 42),
  burlywood: colorRgb(222, 184, 135),
  cadetblue: colorRgb(95, 158, 160),
  chartreuse: colorRgb(127, 255, 0),
  chocolate: colorRgb(210, 105, 30),
  coral: colorRgb(255, 127, 80),
  cornflowerblue: colorRgb(100, 149, 237),
  cornsilk: colorRgb(255, 248, 220),
  crimson: colorRgb(220, 20, 60),
  cyan: colorRgb(0, 255, 255),
  darkblue: colorRgb(0, 0, 139),
  darkcyan: colorRgb(0, 139, 139),
  darkgoldenrod: colorRgb(184, 134, 11),
  darkgray: colorRgb(169, 169, 169),
  darkgreen: colorRgb(0, 100, 0),
  darkgrey: colorRgb(169, 169, 169),
  darkkhaki: colorRgb(189, 183, 107),
  darkmagenta: colorRgb(139, 0, 139),
  darkolivegreen: colorRgb(85, 107, 47),
  darkorange: colorRgb(255, 140, 0),
  darkorchid: colorRgb(153, 50, 204),
  darkred: colorRgb(139, 0, 0),
  darksalmon: colorRgb(233, 150, 122),
  darkseagreen: colorRgb(143, 188, 143),
  darkslateblue: colorRgb(72, 61, 139),
  darkslategray: colorRgb(47, 79, 79),
  darkslategrey: colorRgb(47, 79, 79),
  darkturquoise: colorRgb(0, 206, 209),
  darkviolet: colorRgb(148, 0, 211),
  deeppink: colorRgb(255, 20, 147),
  deepskyblue: colorRgb(0, 191, 255),
  dimgray: colorRgb(105, 105, 105),
  dimgrey: colorRgb(105, 105, 105),
  dodgerblue: colorRgb(30, 144, 255),
  firebrick: colorRgb(178, 34, 34),
  floralwhite: colorRgb(255, 250, 240),
  forestgreen: colorRgb(34, 139, 34),
  fuchsia: colorRgb(255, 0, 255),
  gainsboro: colorRgb(220, 220, 220),
  ghostwhite: colorRgb(248, 248, 255),
  gold: colorRgb(255, 215, 0),
  goldenrod: colorRgb(218, 165, 32),
  gray: colorRgb(128, 128, 128),
  grey: colorRgb(128, 128, 128),
  green: colorRgb(0, 128, 0),
  greenyellow: colorRgb(173, 255, 47),
  honeydew: colorRgb(240, 255, 240),
  hotpink: colorRgb(255, 105, 180),
  indianred: colorRgb(205, 92, 92),
  indigo: colorRgb(75, 0, 130),
  ivory: colorRgb(255, 255, 240),
  khaki: colorRgb(240, 230, 140),
  lavender: colorRgb(230, 230, 250),
  lavenderblush: colorRgb(255, 240, 245),
  lawngreen: colorRgb(124, 252, 0),
  lemonchiffon: colorRgb(255, 250, 205),
  lightblue: colorRgb(173, 216, 230),
  lightcoral: colorRgb(240, 128, 128),
  lightcyan: colorRgb(224, 255, 255),
  lightgoldenrodyellow: colorRgb(250, 250, 210),
  lightgray: colorRgb(211, 211, 211),
  lightgreen: colorRgb(144, 238, 144),
  lightgrey: colorRgb(211, 211, 211),
  lightpink: colorRgb(255, 182, 193),
  lightsalmon: colorRgb(255, 160, 122),
  lightseagreen: colorRgb(32, 178, 170),
  lightskyblue: colorRgb(135, 206, 250),
  lightslategray: colorRgb(119, 136, 153),
  lightslategrey: colorRgb(119, 136, 153),
  lightsteelblue: colorRgb(176, 196, 222),
  lightyellow: colorRgb(255, 255, 224),
  lime: colorRgb(0, 255, 0),
  limegreen: colorRgb(50, 205, 50),
  linen: colorRgb(250, 240, 230),
  magenta: colorRgb(255, 0, 255),
  maroon: colorRgb(128, 0, 0),
  mediumaquamarine: colorRgb(102, 205, 170),
  mediumblue: colorRgb(0, 0, 205),
  mediumorchid: colorRgb(186, 85, 211),
  mediumpurple: colorRgb(147, 112, 219),
  mediumseagreen: colorRgb(60, 179, 113),
  mediumslateblue: colorRgb(123, 104, 238),
  mediumspringgreen: colorRgb(0, 250, 154),
  mediumturquoise: colorRgb(72, 209, 204),
  mediumvioletred: colorRgb(199, 21, 133),
  midnightblue: colorRgb(25, 25, 112),
  mintcream: colorRgb(245, 255, 250),
  mistyrose: colorRgb(255, 228, 225),
  moccasin: colorRgb(255, 228, 181),
  navajowhite: colorRgb(255, 222, 173),
  navy: colorRgb(0, 0, 128),
  oldlace: colorRgb(253, 245, 230),
  olive: colorRgb(128, 128, 0),
  olivedrab: colorRgb(107, 142, 35),
  orange: colorRgb(255, 165, 0),
  orangered: colorRgb(255, 69, 0),
  orchid: colorRgb(218, 112, 214),
  palegoldenrod: colorRgb(238, 232, 170),
  palegreen: colorRgb(152, 251, 152),
  paleturquoise: colorRgb(175, 238, 238),
  palevioletred: colorRgb(219, 112, 147),
  papayawhip: colorRgb(255, 239, 213),
  peachpuff: colorRgb(255, 218, 185),
  peru: colorRgb(205, 133, 63),
  pink: colorRgb(255, 192, 203),
  plum: colorRgb(221, 160, 221),
  powderblue: colorRgb(176, 224, 230),
  purple: colorRgb(128, 0, 128),
  red: colorRgb(255, 0, 0),
  rosybrown: colorRgb(188, 143, 143),
  royalblue: colorRgb(65, 105, 225),
  saddlebrown: colorRgb(139, 69, 19),
  salmon: colorRgb(250, 128, 114),
  sandybrown: colorRgb(244, 164, 96),
  seagreen: colorRgb(46, 139, 87),
  seashell: colorRgb(255, 245, 238),
  sienna: colorRgb(160, 82, 45),
  silver: colorRgb(192, 192, 192),
  skyblue: colorRgb(135, 206, 235),
  slateblue: colorRgb(106, 90, 205),
  slategray: colorRgb(112, 128, 144),
  slategrey: colorRgb(112, 128, 144),
  snow: colorRgb(255, 250, 250),
  springgreen: colorRgb(0, 255, 127),
  steelblue: colorRgb(70, 130, 180),
  tan: colorRgb(210, 180, 140),
  teal: colorRgb(0, 128, 128),
  thistle: colorRgb(216, 191, 216),
  tomato: colorRgb(255, 99, 71),
  turquoise: colorRgb(64, 224, 208),
  violet: colorRgb(238, 130, 238),
  wheat: colorRgb(245, 222, 179),
  white: colorRgb(255, 255, 255),
  whitesmoke: colorRgb(245, 245, 245),
  yellow: colorRgb(255, 255, 0),
  yellowgreen: colorRgb(154, 205, 50),
};

export class EmbThread {
  private _color = 0x000000;
  description: string | null;
  catalogNumber: string | null;
  details: string | null;
  brand: string | null;
  chart: string | null;
  weight: string | null;

  constructor(
    thread: ThreadInput | null = null,
    description: string | null = null,
    catalogNumber: string | null = null,
    details: string | null = null,
    brand: string | null = null,
    chart: string | null = null,
    weight: string | null = null,
  ) {
    this.description = description;
    this.catalogNumber = catalogNumber;
    this.details = details;
    this.brand = brand;
    this.chart = chart;
    this.weight = weight;
    if (thread !== null) this.set(thread);
  }

  toString(): string {
    if (this.description === null) return `EmbThread ${this.hexColor()}`;
    return `EmbThread ${this.description} ${this.hexColor()}`;
  }

  /** __eq__. A number or string compares colour only; an EmbThread compares every attribute. */
  equals(other: EmbThread | number | string | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    if (typeof other === "number") return (this.color & 0xffffff) === (other & 0xffffff);
    if (typeof other === "string") {
      const c = EmbThread.parseStringColor(other);
      return c !== undefined && (this.color & 0xffffff) === (c & 0xffffff);
    }
    if (!(other instanceof EmbThread)) return false;
    return (
      (this.color & 0xffffff) === (other.color & 0xffffff) &&
      this.description === other.description &&
      this.catalogNumber === other.catalogNumber &&
      this.details === other.details &&
      this.brand === other.brand &&
      this.chart === other.chart &&
      this.weight === other.weight
    );
  }

  /** __hash__ */
  hash(): number {
    return this.color & 0xffffff;
  }

  get color(): number {
    return this._color;
  }

  set color(color: number | number[]) {
    if (Array.isArray(color)) {
      const [r, g, b] = color.slice(0, 3);
      color = colorRgb(r, g, b);
    }
    if (typeof color !== "number" || !Number.isInteger(color)) throw new Error("invalid colour value");
    this._color = color;
  }

  get opaqueColor(): number {
    return (0xff000000 | this.color) >>> 0;
  }

  get red(): number {
    return (this.color >> 16) & 0xff;
  }

  get green(): number {
    return (this.color >> 8) & 0xff;
  }

  get blue(): number {
    return this.color & 0xff;
  }

  setColor(r: number, g: number, b: number): void {
    this.color = [r, g, b];
  }

  getOpaqueColor(): number {
    return this.opaqueColor;
  }

  getRed(): number {
    return this.red;
  }

  getGreen(): number {
    return this.green;
  }

  getBlue(): number {
    return this.blue;
  }

  hexColor(): string {
    const h = (n: number) => n.toString(16).padStart(2, "0");
    return `#${h(this.red)}${h(this.green)}${h(this.blue)}`;
  }

  setHexColor(hexString: string): void {
    this.color = colorHex(hexString) as number;
  }

  findNearestColorIndex(values: Palette): number | null {
    return findNearestColorIndex(this.color, values);
  }

  set(thread: ThreadInput): void {
    if (thread instanceof EmbThread) {
      this.color = thread.color;
      this.description = thread.description;
      this.catalogNumber = thread.catalogNumber;
      this.details = thread.details;
      this.brand = thread.brand;
      this.chart = thread.chart;
      this.weight = thread.weight;
    } else if (typeof thread === "number") {
      this.color = thread;
    } else if (typeof thread === "string") {
      this.color = EmbThread.parseStringColor(thread) as number;
    } else if (thread && typeof thread === "object") {
      if (thread.name !== undefined) this.description = thread.name;
      if (thread.description !== undefined) this.description = thread.description;
      if (thread.desc !== undefined) this.description = thread.desc;
      if (thread.brand !== undefined) this.brand = thread.brand;
      if (thread.manufacturer !== undefined) this.brand = thread.manufacturer;
      if (thread.chart !== undefined) this.chart = thread.chart;
      if (thread.color !== undefined || thread.rgb !== undefined) {
        const color = thread.color !== undefined ? thread.color : thread.rgb;
        if (typeof color === "string") this.color = EmbThread.parseStringColor(color) as number;
        else if (color !== undefined) this.color = color;
      }
      if (thread.hex !== undefined) this.setHexColor(thread.hex);
      if (thread.id !== undefined) this.catalogNumber = thread.id;
      if (thread.catalog !== undefined) this.catalogNumber = thread.catalog;
    }
  }

  /** parse_string_color. Returns undefined for unknown names (Python returns None). */
  static parseStringColor(color: string): number | undefined {
    // pystitch: random.getrandbits(24). Deterministic here (see FILLER_COLORS).
    if (color === "random") return FILLER_COLORS[0];
    if (color.slice(0, 1) === "#") return colorHex(color.slice(1));
    const key = color.toLowerCase();
    return Object.prototype.hasOwnProperty.call(COLOR_DICT, key) ? COLOR_DICT[key] : undefined;
  }
}

/**
 * Not in pystitch: the thread slot JefReader leaves as None (a colour-0 palette entry that no colour change used up,
 * normally the first one). readJef keeps this object at the same index, so colour block n uses thread n exactly as in
 * pystitch; the parity dumps show it as null. Everything else (writers, stats, preview) sees the deterministic filler
 * for its index, as for a missing thread: pystitch's own writers would crash on the None.
 */
export class PlaceholderThread extends EmbThread {
  readonly placeholder = true;

  constructor(index: number) {
    super();
    this.color = FILLER_COLORS[index % FILLER_COLORS.length];
    this.description = "Random";
  }
}

/** True for a PlaceholderThread (a colour slot the file left empty). */
export function isPlaceholder(t: EmbThread | null | undefined): t is PlaceholderThread {
  return t instanceof PlaceholderThread;
}
