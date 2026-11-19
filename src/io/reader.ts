// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of ReadHelper.py, with the binary file object pystitch's readers read from (stream.read/seek/tell).
//
// EOF semantics, mirroring a Python file opened "rb":
// - read(n) returns up to n bytes: fewer, or none, at the end. Like stream.read it still consumes what was there.
// - The integer readers (read_int_*, read_sint_8) return null where pystitch returns None: when fewer bytes than
//   they need were left. They never throw on plain EOF, so ported readers keep pystitch's EOF-terminated loops.
// - string(n) / string16(n) decode whatever read(n) returned and return null where pystitch's decode fails.
// - seek may move past the end (later reads return nothing; remaining() is 0) and never loops. A seek to a
//   negative position throws RangeError, as a real file does (OSError: Invalid argument).
// Reading never hangs: every call does a bounded amount of work and only moves the position forward to at most
// the end of the data. Mapping failures to a "corrupt file" error is the caller's job (the public API in api.ts does it).

/** signed8: 0..255 as a signed byte. */
export function signed8(b: number): number {
  if (b > 127) return -256 + b;
  return b;
}

/** signed16: the low 16 bits as a signed value. */
export function signed16(v: number): number {
  v &= 0xffff;
  if (v > 0x7fff) return -0x10000 + v;
  return v;
}

/** signed24: the low 24 bits as a signed value. */
export function signed24(v: number): number {
  v &= 0xffffff;
  if (v > 0x7fffff) return -0x1000000 + v;
  return v;
}

// Python str.strip() with no argument: Unicode whitespace (str.isspace).
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/** Python's str.strip() with no argument (the readers strip decoded header text with it). */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP, "");
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Python's bytes.decode("utf16"): a BOM picks the byte order (and is dropped), otherwise little endian; strict. */
function decodeUtf16(b: Uint8Array): string | null {
  if (b.length % 2 !== 0) return null; // truncated data
  let start = 0;
  let littleEndian = true;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    start = 2;
  } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    start = 2;
    littleEndian = false;
  }
  const units: number[] = [];
  for (let i = start; i < b.length; i += 2) {
    units.push(littleEndian ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  }
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = units[i + 1];
      if (next === undefined || next < 0xdc00 || next > 0xdfff) return null; // illegal UTF-16 surrogate
      i++;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      return null; // illegal encoding
    }
  }
  let out = "";
  for (let i = 0; i < units.length; i += 8192) out += String.fromCharCode(...units.slice(i, i + 8192));
  return out;
}

function toBytes(data: Uint8Array | ArrayBuffer | ArrayLike<number>): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

export class ByteReader {
  readonly data: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array | ArrayBuffer | ArrayLike<number>) {
    this.data = toBytes(data);
  }

  /** Total size in bytes. */
  get length(): number {
    return this.data.length;
  }

  /** stream.tell(). May be past the end after a seek. */
  tell(): number {
    return this.pos;
  }

  /** Bytes left before the end (0 when at or past it). */
  remaining(): number {
    return Math.max(0, this.data.length - this.pos);
  }

  /** stream.seek(offset, whence): whence 0 = from the start, 1 = from the current position, 2 = from the end. */
  seek(offset: number, whence: 0 | 1 | 2 = 0): number {
    if (!Number.isInteger(offset)) throw new TypeError("seek offset must be an integer");
    let target: number;
    if (whence === 0) target = offset;
    else if (whence === 1) target = this.pos + offset;
    else if (whence === 2) target = this.data.length + offset;
    else throw new RangeError(`invalid whence (${String(whence)}, should be 0, 1 or 2)`);
    if (target < 0) throw new RangeError(`negative seek position ${target}`);
    this.pos = target;
    return this.pos;
  }

  /** stream.read(n): up to n bytes (all remaining when n is -1; any other negative n throws, as Python's does); short or empty at EOF. */
  read(n: number): Uint8Array {
    if (!Number.isInteger(n)) throw new TypeError("read size must be an integer");
    if (n < -1) throw new RangeError("read length must be non-negative or -1"); // Python: ValueError
    const start = Math.min(this.pos, this.data.length);
    const end = n < 0 ? this.data.length : Math.min(this.data.length, start + n);
    if (this.pos < this.data.length) this.pos = end;
    return this.data.subarray(start, end);
  }

  /** read_signed: up to n signed bytes (fewer at EOF). */
  signed(n: number): number[] {
    return Array.from(this.read(n), signed8);
  }

  /** read_sint_8: a signed byte, or null at EOF. */
  int8(): number | null {
    const b = this.read(1);
    if (b.length === 1) return signed8(b[0]);
    return null;
  }

  /** read_int_8: an unsigned byte, or null at EOF. */
  uint8(): number | null {
    const b = this.read(1);
    if (b.length === 1) return b[0];
    return null;
  }

  /** read_int_16le: UNSIGNED, as in pystitch. Null when fewer than 2 bytes were left. */
  int16le(): number | null {
    const b = this.read(2);
    if (b.length === 2) return (b[0] & 0xff) + ((b[1] & 0xff) << 8);
    return null;
  }

  /** read_int_16be: UNSIGNED, as in pystitch. */
  int16be(): number | null {
    const b = this.read(2);
    if (b.length === 2) return (b[1] & 0xff) + ((b[0] & 0xff) << 8);
    return null;
  }

  /** read_int_24le: UNSIGNED, as in pystitch. */
  int24le(): number | null {
    const b = this.read(3);
    if (b.length === 3) return (b[0] & 0xff) + ((b[1] & 0xff) << 8) + ((b[2] & 0xff) << 16);
    return null;
  }

  /** read_int_24be: UNSIGNED, as in pystitch. */
  int24be(): number | null {
    const b = this.read(3);
    if (b.length === 3) return (b[2] & 0xff) + ((b[1] & 0xff) << 8) + ((b[0] & 0xff) << 16);
    return null;
  }

  /** read_int_32le: UNSIGNED (0..0xFFFFFFFF), as in pystitch. */
  int32le(): number | null {
    const b = this.read(4);
    if (b.length === 4) return (b[0] & 0xff) + (b[1] & 0xff) * 0x100 + (b[2] & 0xff) * 0x10000 + (b[3] & 0xff) * 0x1000000;
    return null;
  }

  /** read_int_32be: UNSIGNED (0..0xFFFFFFFF), as in pystitch. */
  int32be(): number | null {
    const b = this.read(4);
    if (b.length === 4) return (b[3] & 0xff) + (b[2] & 0xff) * 0x100 + (b[1] & 0xff) * 0x10000 + (b[0] & 0xff) * 0x1000000;
    return null;
  }

  /** read_string_8: up to `length` bytes decoded as strict UTF-8 (a BOM is kept); null if they are not UTF-8. */
  string(length: number): string | null {
    const b = this.read(length);
    try {
      return utf8.decode(b);
    } catch {
      return null; // Must be > 128 chars.
    }
  }

  /** read_string_16: up to `length` bytes decoded like Python's "utf16" codec; null if that fails. */
  string16(length: number): string | null {
    return decodeUtf16(this.read(length));
  }
}
