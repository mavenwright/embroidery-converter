// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of WriteHelper.py, with the binary file object pystitch's writers write to (stream.write/seek/tell).
//
// Semantics mirrored from Python:
// - write_int_* take `value & 0xFF` of shifted values: any integer works (negative ones as two's complement), a
//   non-integer throws TypeError like Python's `float & int`.
// - write(bytes) behaves like stream.write(bytes(bytearray(values))): each value must be an integer in 0..255
//   (RangeError otherwise, as bytearray raises ValueError).
// - Writing after seek overwrites in place; seeking past the end and writing fills the gap with zeros, as files do.
// - write_float_32le packs like struct.pack("<f"): round to nearest float32, OverflowError (RangeError here) when a
//   finite value does not fit.
// - Strings encode like bytes(string, encoding) for "utf8" and "UTF-16BE"/"UTF-16LE"/"UTF-16"; lone surrogates throw,
//   as Python's encoders raise.

function checkInt(value: number): void {
  if (!Number.isInteger(value)) throw new TypeError(`expected an integer, got ${value}`);
}

function checkNoLoneSurrogates(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new RangeError("surrogates not allowed");
      i++;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      throw new RangeError("surrogates not allowed");
    }
  }
}

const utf8 = new TextEncoder();

/** bytes(string, encoding) for the encodings pystitch's writers use. */
export function encodeString(s: string, encoding = "utf8"): Uint8Array {
  checkNoLoneSurrogates(s);
  const name = encoding.toLowerCase().replace(/[-_]/g, "");
  if (name === "utf8") return utf8.encode(s);
  if (name === "utf16be" || name === "utf16le" || name === "utf16") {
    const bom = name === "utf16" ? 2 : 0; // Python's "utf-16" writes a BOM, then native (little endian) order.
    const out = new Uint8Array(bom + s.length * 2);
    if (bom) {
      out[0] = 0xff;
      out[1] = 0xfe;
    }
    const littleEndian = name !== "utf16be";
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      const o = bom + i * 2;
      out[o] = littleEndian ? u & 0xff : u >> 8;
      out[o + 1] = littleEndian ? u >> 8 : u & 0xff;
    }
    return out;
  }
  throw new RangeError(`unknown encoding: ${encoding}`);
}

export class ByteWriter {
  private buf: Uint8Array;
  private pos = 0;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(Math.max(1, initialCapacity));
  }

  /** Bytes written so far (the file size). */
  get length(): number {
    return this.len;
  }

  /** stream.tell() */
  tell(): number {
    return this.pos;
  }

  /** stream.seek(offset, whence): whence 0 = from the start, 1 = from the current position, 2 = from the end. */
  seek(offset: number, whence: 0 | 1 | 2 = 0): number {
    checkInt(offset);
    let target: number;
    if (whence === 0) target = offset;
    else if (whence === 1) target = this.pos + offset;
    else if (whence === 2) target = this.len + offset;
    else throw new RangeError(`invalid whence (${String(whence)}, should be 0, 1 or 2)`);
    if (target < 0) throw new RangeError(`negative seek position ${target}`);
    this.pos = target;
    return this.pos;
  }

  private ensure(capacity: number): void {
    if (capacity <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < capacity) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private put(bytes: Uint8Array): void {
    const end = this.pos + bytes.length;
    this.ensure(end);
    // A gap left by seeking past the end is already zero: the buffer is zero-initialised and only grows.
    this.buf.set(bytes, this.pos);
    this.pos = end;
    if (end > this.len) this.len = end;
  }

  /** stream.write(bytes(bytearray(values))). Values must be integers in 0..255. */
  write(values: Uint8Array | ArrayLike<number>): void {
    if (values instanceof Uint8Array) {
      this.put(values);
      return;
    }
    const bytes = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      checkInt(v);
      if (v < 0 || v > 255) throw new RangeError("byte must be in range(0, 256)");
      bytes[i] = v;
    }
    this.put(bytes);
  }

  /** write_int_array_8 */
  int8Array(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.int8(values[i]);
  }

  /** write_int_8 */
  int8(value: number): void {
    checkInt(value);
    this.put(Uint8Array.of(value & 0xff));
  }

  /** write_int_16le */
  int16le(value: number): void {
    checkInt(value);
    this.put(Uint8Array.of((value >> 0) & 0xff, (value >> 8) & 0xff));
  }

  /** write_int_16be */
  int16be(value: number): void {
    checkInt(value);
    this.put(Uint8Array.of((value >> 8) & 0xff, (value >> 0) & 0xff));
  }

  /** write_int_24le */
  int24le(value: number): void {
    checkInt(value);
    this.put(Uint8Array.of((value >> 0) & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff));
  }

  /** write_int_24be */
  int24be(value: number): void {
    checkInt(value);
    this.put(Uint8Array.of((value >> 16) & 0xff, (value >> 8) & 0xff, (value >> 0) & 0xff));
  }

  /** write_int_32le. JS shifts see the value modulo 2^32, which gives Python's bytes for any safe integer. */
  int32le(value: number): void {
    checkInt(value);
    this.put(Uint8Array.of((value >> 0) & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff));
  }

  /** write_int_32be */
  int32be(value: number): void {
    checkInt(value);
    this.put(Uint8Array.of((value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, (value >> 0) & 0xff));
  }

  /** write_float_32le: struct.pack("<f", float(value)). */
  float32le(value: number): void {
    const f = Math.fround(value);
    if (!Number.isFinite(f) && Number.isFinite(value)) throw new RangeError("float too large to pack with f format");
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.put(bytes);
  }

  /** write_string(stream, string, encoding="utf8") */
  string(s: string, encoding = "utf8"): void {
    this.put(encodeString(s, encoding));
  }

  /** write_string_utf8 */
  stringUtf8(s: string): void {
    this.put(encodeString(s, "utf8"));
  }

  /** The bytes written, as a new array. */
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
