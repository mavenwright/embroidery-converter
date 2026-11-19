// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of PecGraphics.py (pystitch 1.0.1): the 48 x 38 one-bit PEC thumbnails. The blank icon is pystitch's, verbatim
// (generated from the Python source, one row of 6 bytes per line).
//
// pystitch -> TS: blank -> BLANK; get_blank -> getBlank; draw -> draw; draw_scaled -> drawScaled;
// graphic_mark_bit -> graphicMarkBit; graphic_unmark_bit -> graphicUnmarkBit; get_graphic_as_string -> getGraphicAsString.
// Not ported: create (raises TypeError in Python 3: a list times a float) and clear (assigns to its loop variable,
// so it never changes the graphic). pystitch uses neither.
//
// Python list semantics are kept: a negative byte index counts from the end, an index out of range raises
// IndexError, which draw and draw_scaled swallow (the point is skipped). x % 8 is Python's (never negative).
import { pyMod } from "../core/encoder";

/** A PEC graphic: one bit per pixel, `stride` bytes per row (bytes 0..255). */
export type Graphic = number[];
/** [left, top, right, bottom], as EmbPattern.bounds(). */
export type Extends = readonly [number, number, number, number];
export type Point = ArrayLike<number>;

const BLANK: readonly number[] = Object.freeze([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x10,
  0x04, 0x00, 0x00, 0x00, 0x00, 0x20,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x04, 0x00, 0x00, 0x00, 0x00, 0x20,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x10,
  0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** get_blank: a fresh copy of the blank 6 x 38 icon (a rounded frame). */
export function getBlank(): Graphic {
  return BLANK.slice();
}

/** The list index Python would use for graphic[index], or -1 where Python raises IndexError. */
function pyIndex(graphic: Graphic, index: number): number {
  const i = index < 0 ? index + graphic.length : index;
  return i >= 0 && i < graphic.length ? i : -1;
}

/** graphic_mark_bit without the raise: false where Python raises IndexError. */
function markBit(graphic: Graphic, x: number, y: number, stride: number): boolean {
  const i = pyIndex(graphic, y * stride + Math.trunc(x / 8));
  if (i < 0) return false;
  graphic[i] |= 1 << pyMod(x, 8);
  return true;
}

/** graphic_mark_bit: expressly sets the bit in the given graphic object. Throws RangeError where Python raises IndexError. */
export function graphicMarkBit(graphic: Graphic, x: number, y: number, stride = 6): void {
  if (!markBit(graphic, x, y, stride)) throw new RangeError("list index out of range");
}

/** graphic_unmark_bit: expressly unsets the bit in the given graphic object. */
export function graphicUnmarkBit(graphic: Graphic, x: number, y: number, stride = 6): void {
  const i = pyIndex(graphic, y * stride + Math.trunc(x / 8));
  if (i < 0) throw new RangeError("list index out of range");
  graphic[i] &= ~(1 << pyMod(x, 8));
}

/** draw: marks each point (int() of its coordinates) unscaled; points off the graphic are skipped. */
export function draw(points: Iterable<Point>, graphic: Graphic, stride = 6): void {
  for (const point of points) markBit(graphic, Math.trunc(point[0]), Math.trunc(point[1]), stride);
}

/**
 * draw_scaled: fits `extends` into the graphic (keeping the aspect ratio, `buffer` pixels smaller), centred, and marks
 * each point. Points that land off the graphic are skipped (Python's IndexError), negative indexes wrap.
 */
export function drawScaled(extends_: Extends | null, points: Iterable<Point>, graphic: Graphic, stride: number, buffer = 5): void {
  if (extends_ === null) {
    draw(points, graphic, stride);
    return;
  }
  const left = extends_[0];
  const top = extends_[1];
  const right = extends_[2];
  const bottom = extends_[3];

  let diagramWidth = right - left;
  let diagramHeight = bottom - top;

  const graphicWidth = stride * 8;
  const graphicHeight = graphic.length / stride;

  if (diagramWidth === 0) diagramWidth = 1;
  if (diagramHeight === 0) diagramHeight = 1;

  const scaleX = (graphicWidth - buffer) / diagramWidth;
  const scaleY = (graphicHeight - buffer) / diagramHeight;

  const scale = scaleY < scaleX ? scaleY : scaleX; // min(scale_x, scale_y)

  const cx = (right + left) / 2;
  const cy = (bottom + top) / 2;

  let translateX = -cx;
  let translateY = -cy;

  translateX *= scale;
  translateY *= scale;

  translateX += graphicWidth / 2;
  translateY += graphicHeight / 2;

  for (const point of points) {
    markBit(graphic, Math.floor(point[0] * scale + translateX), Math.floor(point[1] * scale + translateY), stride);
  }
}

/** get_graphic_as_string: the graphic as text, `one` for set bits, one line per row. */
export function getGraphicAsString(graphic: Graphic | Uint8Array | readonly [Graphic | Uint8Array, number], one = "#", zero = " "): string {
  let stride = 6;
  let bytes: ArrayLike<number>;
  if (graphic.length === 2 && typeof graphic[1] === "number" && typeof graphic[0] === "object") {
    const tuple = graphic as readonly [Graphic | Uint8Array, number];
    stride = tuple[1];
    bytes = tuple[0];
  } else {
    bytes = graphic as ArrayLike<number>;
  }
  const listString: string[] = [];
  for (let n = 0; n < bytes.length; n++) {
    for (let i = 0; i < 8; i++) listString.push((bytes[n] >> i) & 1 ? one : zero);
  }
  const bitStride = 8 * stride;
  const bitLength = 8 * bytes.length;
  const lines: string[] = [];
  for (let m = 0; m < bitLength; m += bitStride) lines.push(listString.slice(m, m + bitStride).join(""));
  return lines.join("\n");
}
