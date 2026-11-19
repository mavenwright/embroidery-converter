// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of EmbMatrix.py. Every expression keeps pystitch's operand order so the doubles match Python's floats.
// Known, byte-invisible difference: Python multiplies int matrix entries as ints, which have no signed zero, so
// e.g. 0 * -22 is 0 in Python and -0 here. Coordinates only differ in the sign of an exact zero.

export type Matrix = number[];

/** Python's float division: dividing by zero raises ZeroDivisionError instead of returning Infinity. */
function floatDivide(a: number, b: number): number {
  if (b === 0) throw new RangeError("ZeroDivisionError: float division by zero");
  return a / b;
}

export class EmbMatrix {
  m: Matrix;

  constructor(m?: Matrix | null) {
    this.m = m == null ? EmbMatrix.getIdentity() : m;
  }

  /** __eq__ */
  equals(other: EmbMatrix): boolean {
    if (this.m.length !== other.m.length) return false;
    for (let i = 0; i < this.m.length; i++) if (this.m[i] !== other.m[i]) return false;
    return true;
  }

  getMatrix(): Matrix {
    return this.m;
  }

  reset(): void {
    this.m = EmbMatrix.getIdentity();
  }

  inverse(): void {
    const m = this.m;
    const m48s75 = m[4] * m[8] - m[7] * m[5];
    const m38s56 = m[5] * m[6] - m[3] * m[8];
    const m37s46 = m[3] * m[7] - m[4] * m[6];
    const det = m[0] * m48s75 + m[1] * m38s56 + m[2] * m37s46;
    const inverseDet = floatDivide(1.0, det);
    this.m = [
      m48s75 * inverseDet,
      (m[2] * m[7] - m[1] * m[8]) * inverseDet,
      (m[1] * m[5] - m[2] * m[4]) * inverseDet,
      m38s56 * inverseDet,
      (m[0] * m[8] - m[2] * m[6]) * inverseDet,
      (m[3] * m[2] - m[0] * m[5]) * inverseDet,
      m37s46 * inverseDet,
      (m[6] * m[1] - m[0] * m[7]) * inverseDet,
      (m[0] * m[4] - m[3] * m[1]) * inverseDet,
    ];
  }

  postScale(sx = 1, sy: number | null = null, x: number | null = 0, y: number | null = 0): void {
    if (sy === null) sy = sx;
    if (x === null) x = 0;
    if (y === null) y = 0;
    if (x === 0 && y === 0) {
      this.m = EmbMatrix.matrixMultiply(this.m, EmbMatrix.getScale(sx, sy));
    } else {
      this.postTranslate(-x, -y);
      this.postScale(sx, sy);
      this.postTranslate(x, y);
    }
  }

  postTranslate(tx: number, ty: number): void {
    this.m = EmbMatrix.matrixMultiply(this.m, EmbMatrix.getTranslate(tx, ty));
  }

  postRotate(theta: number, x: number | null = 0, y: number | null = 0): void {
    if (x === null) x = 0;
    if (y === null) y = 0;
    if (x === 0 && y === 0) {
      this.m = EmbMatrix.matrixMultiply(this.m, EmbMatrix.getRotate(theta));
    } else {
      this.postTranslate(-x, -y);
      this.postRotate(theta);
      this.postTranslate(x, y);
    }
  }

  postCat(matrixList: Matrix[]): void {
    for (const mx of matrixList) this.m = EmbMatrix.matrixMultiply(this.m, mx);
  }

  preScale(sx = 1, sy: number | null = null): void {
    if (sy === null) sy = sx;
    this.m = EmbMatrix.matrixMultiply(EmbMatrix.getScale(sx, sy), this.m);
  }

  preTranslate(tx: number, ty: number): void {
    this.m = EmbMatrix.matrixMultiply(EmbMatrix.getTranslate(tx, ty), this.m);
  }

  preRotate(theta: number): void {
    this.m = EmbMatrix.matrixMultiply(EmbMatrix.getRotate(theta), this.m);
  }

  preCat(matrixList: Matrix[]): void {
    for (const mx of matrixList) this.m = EmbMatrix.matrixMultiply(mx, this.m);
  }

  /**
   * point_in_matrix_space. With one argument it maps a sequence [x, y, ...] and keeps its third element when there
   * is one (a stitch keeps its command); with two it maps the point (x, y).
   */
  pointInMatrixSpace(v0: readonly number[]): number[];
  pointInMatrixSpace(v0: number, v1: number): [number, number];
  pointInMatrixSpace(v0: readonly number[] | number, v1?: number | null): number[] {
    const m = this.m;
    if (v1 === undefined || v1 === null) {
      const v = v0 as readonly number[];
      if (v.length > 2) {
        return [v[0] * m[0] + v[1] * m[3] + 1 * m[6], v[0] * m[1] + v[1] * m[4] + 1 * m[7], v[2]];
      }
      // Must not have had a 3rd element.
      return [v[0] * m[0] + v[1] * m[3] + 1 * m[6], v[0] * m[1] + v[1] * m[4] + 1 * m[7]];
    }
    const x = v0 as number;
    return [x * m[0] + v1 * m[3] + 1 * m[6], x * m[1] + v1 * m[4] + 1 * m[7]];
  }

  apply(v: number[]): void {
    const m = this.m;
    const nx = v[0] * m[0] + v[1] * m[3] + 1 * m[6];
    const ny = v[0] * m[1] + v[1] * m[4] + 1 * m[7];
    v[0] = nx;
    v[1] = ny;
  }

  static getIdentity(): Matrix {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1]; // identity
  }

  static getScale(sx: number, sy: number | null = null): Matrix {
    if (sy === null) sy = sx;
    return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
  }

  static getTranslate(tx: number, ty: number): Matrix {
    return [1, 0, 0, 0, 1, 0, tx, ty, 1];
  }

  /** Degrees. Uses Math.cos/Math.sin where pystitch uses the C library's cos/sin (see the encoder notes). */
  static getRotate(theta: number): Matrix {
    const tau = Math.PI * 2;
    theta *= tau / 360;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    return [ct, st, 0, -st, ct, 0, 0, 0, 1];
  }

  static matrixMultiply(m0: Matrix, m1: Matrix): Matrix {
    return [
      m0[0] * m1[0] + m0[1] * m1[3] + m0[2] * m1[6],
      m0[0] * m1[1] + m0[1] * m1[4] + m0[2] * m1[7],
      m0[0] * m1[2] + m0[1] * m1[5] + m0[2] * m1[8],
      m0[3] * m1[0] + m0[4] * m1[3] + m0[5] * m1[6],
      m0[3] * m1[1] + m0[4] * m1[4] + m0[5] * m1[7],
      m0[3] * m1[2] + m0[4] * m1[5] + m0[5] * m1[8],
      m0[6] * m1[0] + m0[7] * m1[3] + m0[8] * m1[6],
      m0[6] * m1[1] + m0[7] * m1[4] + m0[8] * m1[7],
      m0[6] * m1[2] + m0[7] * m1[5] + m0[8] * m1[8],
    ];
  }
}
