import { describe, expect, it } from "vitest";
import { ByteReader, signed16, signed24, signed8 } from "../../src/io/reader";
import { ByteWriter } from "../../src/io/writer";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("ByteReader (ReadHelper semantics)", () => {
  it("reads unsigned little- and big-endian integers like read_int_*", () => {
    const r = new ByteReader(bytes(0x01, 0x02, 0x03, 0x04));
    expect(r.int16le()).toBe(0x0201);
    r.seek(0);
    expect(r.int16be()).toBe(0x0102);
    r.seek(0);
    expect(r.int24le()).toBe(0x030201);
    r.seek(0);
    expect(r.int24be()).toBe(0x010203);
    r.seek(0);
    expect(r.int32le()).toBe(0x04030201);
    r.seek(0);
    expect(r.int32be()).toBe(0x01020304);
    const ff = new ByteReader(bytes(0xff, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00));
    expect(ff.int32le()).toBe(0xffffffff); // unsigned, as pystitch
    expect(ff.int32le()).toBe(0x80);
    expect(new ByteReader(bytes(0x80, 0, 0, 0)).int32be()).toBe(0x80000000);
  });

  it("int8 is signed (read_sint_8) and uint8 is unsigned (read_int_8)", () => {
    const r = new ByteReader(bytes(0x7f, 0x80, 0xff, 0x00));
    expect([r.int8(), r.int8(), r.int8(), r.int8()]).toEqual([127, -128, -1, 0]);
    r.seek(0);
    expect([r.uint8(), r.uint8(), r.uint8(), r.uint8()]).toEqual([127, 128, 255, 0]);
    expect(r.signed(10)).toEqual([]);
    r.seek(1);
    expect(r.signed(10)).toEqual([-128, -1, 0]);
  });

  it("signed8/16/24 helpers", () => {
    expect([signed8(0x7f), signed8(0x80), signed8(0xff)]).toEqual([127, -128, -1]);
    expect([signed16(0x7fff), signed16(0x8000), signed16(0x1ffff)]).toEqual([0x7fff, -0x8000, -1]);
    expect([signed24(0x7fffff), signed24(0x800000), signed24(0xffffff)]).toEqual([0x7fffff, -0x800000, -1]);
  });

  it("short reads at EOF return null and still consume what was there (stream.read semantics)", () => {
    const r = new ByteReader(bytes(0xaa, 0xbb, 0xcc));
    expect(r.int16le()).toBe(0xbbaa);
    expect(r.int16le()).toBeNull();
    expect(r.tell()).toBe(3);
    expect(r.uint8()).toBeNull();
    expect(r.int8()).toBeNull();
    expect(r.int32be()).toBeNull();
    expect(r.read(4)).toEqual(new Uint8Array(0));
    expect(r.remaining()).toBe(0);
  });

  it("read(n) returns short data at EOF so EOF-terminated loops end", () => {
    const r = new ByteReader(bytes(1, 2, 3, 4, 5, 6, 7));
    const records: number[][] = [];
    for (;;) {
      const b = r.read(3);
      if (b.length !== 3) break;
      records.push([...b]);
    }
    expect(records).toEqual([[1, 2, 3], [4, 5, 6]]);
    r.seek(5);
    expect([...r.read(-1)]).toEqual([6, 7]); // Python read(-1): the rest
    r.seek(0);
    expect(r.read(0).length).toBe(0);
  });

  it("seek follows file semantics: SEEK_SET/CUR/END, past-the-end allowed, negative throws", () => {
    const r = new ByteReader(bytes(10, 20, 30, 40));
    expect(r.seek(2)).toBe(2);
    expect(r.uint8()).toBe(30);
    expect(r.seek(-2, 1)).toBe(1);
    expect(r.uint8()).toBe(20);
    expect(r.seek(-1, 2)).toBe(3);
    expect(r.uint8()).toBe(40);
    expect(r.seek(1000)).toBe(1000);
    expect(r.tell()).toBe(1000);
    expect(r.remaining()).toBe(0);
    expect(r.uint8()).toBeNull();
    expect(r.tell()).toBe(1000);
    expect(() => r.seek(-1)).toThrow(RangeError);
    expect(() => r.seek(-2000, 1)).toThrow(RangeError);
    expect(() => r.seek(1.5)).toThrow(TypeError);
    expect(() => r.seek(0, 3 as 0)).toThrow(RangeError);
  });

  it("string(n) decodes strict UTF-8 like read_string_8 (null on bad bytes, BOM kept)", () => {
    expect(new ByteReader(new TextEncoder().encode("#PES0001")).string(8)).toBe("#PES0001");
    expect(new ByteReader(bytes(0xef, 0xbb, 0xbf, 0x61)).string(4)).toBe("﻿a");
    expect(new ByteReader(bytes(0x61, 0xff, 0x62)).string(3)).toBeNull();
    expect(new ByteReader(bytes(0xed, 0xa0, 0x80)).string(3)).toBeNull(); // encoded surrogate
    const short = new ByteReader(bytes(0x61, 0x62));
    expect(short.string(8)).toBe("ab");
    expect(short.tell()).toBe(2);
  });

  it("string16(n) decodes like Python's utf16 codec (BOM picks the order, default LE, strict)", () => {
    expect(new ByteReader(bytes(0x61, 0x00, 0x62, 0x00)).string16(4)).toBe("ab");
    expect(new ByteReader(bytes(0xff, 0xfe, 0x61, 0x00)).string16(4)).toBe("a");
    expect(new ByteReader(bytes(0xfe, 0xff, 0x00, 0x61)).string16(4)).toBe("a");
    expect(new ByteReader(bytes(0x3d, 0xd8, 0x00, 0xde)).string16(4)).toBe("\u{1f600}");
    expect(new ByteReader(bytes(0x61, 0x00, 0x62)).string16(3)).toBeNull(); // truncated data
    expect(new ByteReader(bytes(0x00, 0xdc)).string16(2)).toBeNull(); // lone low surrogate
    expect(new ByteReader(bytes(0x3d, 0xd8, 0x61, 0x00)).string16(4)).toBeNull(); // unpaired high surrogate
  });

  it("accepts ArrayBuffer and number arrays", () => {
    expect(new ByteReader(new Uint8Array([5, 6]).buffer).uint8()).toBe(5);
    expect(new ByteReader([7]).uint8()).toBe(7);
    expect(new ByteReader(new Uint8Array(0)).length).toBe(0);
  });
});

describe("ByteWriter (WriteHelper semantics)", () => {
  it("writes integers masked to their width in both byte orders", () => {
    const w = new ByteWriter();
    w.int8(300);
    w.int8(-1);
    w.int16le(0x1234);
    w.int16be(0x1234);
    w.int16le(-2);
    w.int24le(0x123456);
    w.int24be(0x123456);
    w.int32le(0x12345678);
    w.int32be(0x12345678);
    w.int32le(0xffffffff);
    w.int32be(-1);
    w.int32le(2 ** 32 + 5);
    w.int8Array([1, 258, -3]);
    expect([...w.toUint8Array()]).toEqual([
      0x2c, 0xff, 0x34, 0x12, 0x12, 0x34, 0xfe, 0xff, 0x56, 0x34, 0x12, 0x12, 0x34, 0x56, 0x78, 0x56, 0x34, 0x12, 0x12,
      0x34, 0x56, 0x78, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 5, 0, 0, 0, 1, 2, 0xfd,
    ]);
  });

  it("rejects non-integers like Python's int operators", () => {
    const w = new ByteWriter();
    expect(() => w.int16le(1.5)).toThrow(TypeError);
    expect(() => w.int8(NaN)).toThrow(TypeError);
    expect(() => w.write([256])).toThrow(RangeError); // bytearray: byte must be in range(0, 256)
    expect(() => w.write([-1])).toThrow(RangeError);
    expect(() => w.write([0.5])).toThrow(TypeError);
  });

  it("float32le packs like struct.pack('<f') and overflows like it", () => {
    const w = new ByteWriter();
    w.float32le(1);
    w.float32le(0);
    w.float32le(-2.5);
    w.float32le(Infinity);
    expect([...w.toUint8Array()]).toEqual([0, 0, 0x80, 0x3f, 0, 0, 0, 0, 0, 0, 0x20, 0xc0, 0, 0, 0x80, 0x7f]);
    expect(() => w.float32le(1e40)).toThrow(RangeError);
  });

  it("strings: utf8 by default, UTF-16BE on request, lone surrogates rejected", () => {
    const w = new ByteWriter();
    w.stringUtf8("é");
    w.string("A\u{1f600}", "UTF-16BE");
    w.string("b");
    expect([...w.toUint8Array()]).toEqual([0xc3, 0xa9, 0x00, 0x41, 0xd8, 0x3d, 0xde, 0x00, 0x62]);
    expect(() => w.stringUtf8("\ud800")).toThrow();
    expect(() => w.string("\udc00", "UTF-16BE")).toThrow();
    expect(() => w.string("x", "cp437")).toThrow();
  });

  it("seek/tell: overwrite in place, zero-fill a gap, negative seek throws", () => {
    const w = new ByteWriter(2);
    w.write([1, 2, 3, 4]);
    const placeholder = w.tell();
    w.int16le(0);
    w.write([9]);
    const end = w.tell();
    w.seek(placeholder, 0);
    w.int16le(0xbeef);
    w.seek(end, 0);
    w.write([7]);
    expect([...w.toUint8Array()]).toEqual([1, 2, 3, 4, 0xef, 0xbe, 9, 7]);
    w.seek(10);
    w.write([5]);
    expect([...w.toUint8Array()]).toEqual([1, 2, 3, 4, 0xef, 0xbe, 9, 7, 0, 0, 5]);
    expect(w.seek(-1, 2)).toBe(10);
    expect(w.seek(-2, 1)).toBe(8);
    expect(() => w.seek(-1)).toThrow(RangeError);
    expect(w.length).toBe(11);
  });

  it("grows past its initial capacity and returns a copy", () => {
    const w = new ByteWriter(1);
    for (let i = 0; i < 100_000; i++) w.int8(i);
    const out = w.toUint8Array();
    expect(out.length).toBe(100_000);
    expect(out[99_999]).toBe(99_999 & 0xff);
    out[0] = 0xaa;
    expect(w.toUint8Array()[0]).toBe(0);
  });
});
