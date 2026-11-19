// The API's integrity check is about the stitch data. A file whose stitch data is complete is read even when
// header fields the reader does not use are wrong; a file cut inside its stitch data is still corrupt. The damaged
// files are built here from the synthetic corpus, so these tests do not depend on corpus/local.
import { describe, expect, it } from "vitest";
import { EmbroideryReadError, detectFormat, readDst, readEmbroidery, readJef, readPes, readVp3 } from "../src/index";
import type { EmbPattern } from "../src/core/pattern";
import { HAS_PYTHON, loadReference, pythonRead, toRefShape } from "./helpers/parity";

const u32le = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const setU32le = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
};
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof EmbroideryReadError ? e.code : `raw ${String(e)}`;
  }
};
/** The API read is the reader's read, and pystitch reads the damaged file the same way. */
function expectReadsLike(damaged: Uint8Array, ext: string, original: EmbPattern, reader: (b: Uint8Array) => EmbPattern): void {
  const viaApi = toRefShape(readEmbroidery(damaged, `damaged.${ext}`));
  expect(viaApi.stitches).toEqual(toRefShape(original).stitches);
  expect(viaApi).toEqual(toRefShape(reader(damaged)));
  if (HAS_PYTHON) expect(pythonRead(damaged, ext)).toEqual(viaApi);
}

describe("PES: PEC length field and thumbnails", () => {
  // colors3.pes as pystitch writes it: the PEC stitch-block length ends right after the 0xFF, thumbnails follow.
  const original = loadReference("colors3", "pes").bytes;
  const pec = u32le(original, 8);
  const lenAt = pec + 514;
  const stitchBlockEnd = (original[lenAt] | (original[lenAt + 1] << 8) | (original[lenAt + 2] << 16)) - 5 + lenAt + 3;

  /** No thumbnails at all (the file ends FF 00), and the length field off by `delta`. */
  function noThumbnails(delta: number): Uint8Array {
    expect(original[stitchBlockEnd - 1]).toBe(0xff);
    const b = new Uint8Array(stitchBlockEnd + 1);
    b.set(original.subarray(0, stitchBlockEnd));
    b[stitchBlockEnd] = 0x00;
    const len = (b[lenAt] | (b[lenAt + 1] << 8) | (b[lenAt + 2] << 16)) + delta;
    b[lenAt] = len & 0xff;
    b[lenAt + 1] = (len >> 8) & 0xff;
    b[lenAt + 2] = (len >> 16) & 0xff;
    return b;
  }

  it("a wrong stitch-block length and no thumbnails: read in full, as pystitch reads it", () => {
    for (const delta of [3, 4, 1000]) expectReadsLike(noThumbnails(delta), "pes", readPes(original), readPes);
  });
  it("zeroed width and height fields do not matter either", () => {
    const b = noThumbnails(4);
    b.fill(0, lenAt + 6, lenAt + 14); // width, height, 0x1E0, 0x1B0
    expectReadsLike(b, "pes", readPes(original), readPes);
  });
  it("a length that agrees with the stitch data announces thumbnails: a file without them was cut, so corrupt", () => {
    expect(codeOf(() => readEmbroidery(noThumbnails(0), "x.pes"))).toBe("corrupt");
  });
  it("a wrong length does not excuse stitch data that is cut off", () => {
    const b = noThumbnails(4);
    for (const cut of [lenAt + 3 + 15 + 2, Math.floor((lenAt + stitchBlockEnd) / 2), stitchBlockEnd - 1]) {
      expect(codeOf(() => readEmbroidery(b.slice(0, cut), "x.pes")), `cut at ${cut}`).toBe("corrupt");
    }
  });
});

describe("JEF: a header that fails JefWriter's offset formula", () => {
  // colors3.jef: 3 colours, indices at 0x74, the per-colour type table after them, stitches at 0x74 + 8 * 3.
  const original = loadReference("colors3", "jef").bytes;
  const n = u32le(original, 24);
  /** The type table left out (stitches at 0x74 + 4n) and the hoop and extent fields zeroed. */
  function shortHeader(): Uint8Array {
    const head = original.slice(0, 0x74 + 4 * n);
    const body = original.subarray(u32le(original, 0));
    const b = new Uint8Array(head.length + body.length);
    b.set(head);
    b.set(body, head.length);
    setU32le(b, 0, 0x74 + 4 * n);
    b.fill(0, 32, 0x74);
    return b;
  }

  it("named .jef, it is a JEF and reads in full, as pystitch reads it", () => {
    const b = shortHeader();
    expect(detectFormat(b, "x.jef")).toBe("jef");
    expect(detectFormat(b, "X.JEF")).toBe("jef");
    expectReadsLike(b, "jef", readJef(original), readJef);
  });
  it("without the .jef name it is not guessed to be a JEF", () => {
    expect(detectFormat(shortHeader(), "x.dst")).toBeNull();
    expect(detectFormat(shortHeader())).toBeNull();
  });
  it("cut anywhere after its header, it is corrupt", () => {
    const b = shortHeader();
    for (let cut = 28; cut < b.length; cut++) {
      expect(codeOf(() => readEmbroidery(b.slice(0, cut), "x.jef")), `cut at ${cut}`).toBe("corrupt");
    }
  });
  it("a foreign file named .jef whose header JefReader cannot follow is still unknown_format", () => {
    expect(codeOf(() => readEmbroidery(loadReference("colors3", "exp").bytes, "x.jef"))).toBe("unknown_format");
    const noisy = new Uint8Array(4000);
    let seed = 7;
    for (let i = 0; i < noisy.length; i++) noisy[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    setU32le(noisy, 24, 0x2000000); // more colours than any header holds
    expect(codeOf(() => readEmbroidery(noisy, "x.jef"))).toBe("unknown_format");
    setU32le(noisy, 24, 3);
    setU32le(noisy, 0, 0x74); // stitch offset inside the colour indices
    expect(codeOf(() => readEmbroidery(noisy, "x.jef"))).toBe("unknown_format");
  });
  it("data that is not JEF records (an unknown control code) under a usable header is unknown_format, not corrupt", () => {
    const b = shortHeader();
    const off = u32le(b, 0);
    b.set([0x80, 0x07, 0, 0], off + 2); // a control JefReader does not know, early in the stitch data
    expect(codeOf(() => readEmbroidery(b, "x.jef"))).toBe("unknown_format");
  });
  it("an offset far beyond a full header is not a usable header", () => {
    const b = shortHeader();
    setU32le(b, 0, 0x74 + 8 * n + 513);
    expect(detectFormat(b, "x.jef")).toBeNull();
  });
  it("an offset that points before the colour indices is not a usable header", () => {
    const b = shortHeader();
    setU32le(b, 0, 0x74 + 4 * n - 4);
    expect(detectFormat(b, "x.jef")).toBeNull();
  });
});

describe("VP3: the outer block's length is not used", () => {
  const original = loadReference("colors3", "vp3").bytes;
  const p = 8 + ((original[6] << 8) | original[7]);
  /** The outer block's 00 02 00 and length zeroed, as an old writer left them. */
  function zeroedOuter(): Uint8Array {
    const b = Uint8Array.from(original);
    b.fill(0, p, p + 7);
    return b;
  }

  it("is read in full from the colour blocks, as pystitch reads it", () => {
    expectReadsLike(zeroedOuter(), "vp3", readVp3(original), readVp3);
  });
  it("cut inside a colour block, it is corrupt", () => {
    const b = zeroedOuter();
    for (const cut of [p + 200, Math.floor(b.length * 0.75), b.length - 1]) {
      expect(codeOf(() => readEmbroidery(b.slice(0, cut), "x.vp3")), `cut at ${cut}`).toBe("corrupt");
    }
  });
  it("a damaged colour-block marker is corrupt", () => {
    const b = zeroedOuter();
    // Vp3Reader's header walk to the first colour block.
    let pos = p + 7;
    const skip = (): void => {
      pos += 2 + ((b[pos] << 8) | b[pos + 1]);
    };
    skip();
    pos += 67;
    skip();
    pos += 24;
    skip();
    pos += 2;
    expect([b[pos], b[pos + 1], b[pos + 2]]).toEqual([0, 5, 0]);
    b[pos + 1] = 7;
    expect(codeOf(() => readEmbroidery(b, "x.vp3"))).toBe("corrupt");
  });
  it("a complete file with a wrong outer length or marker is read in full", () => {
    const setU32be = (b: Uint8Array, o: number, v: number): void => {
      b[o] = v >>> 24;
      b[o + 1] = (v >>> 16) & 0xff;
      b[o + 2] = (v >>> 8) & 0xff;
      b[o + 3] = v & 0xff;
    };
    const outer = ((original[p + 3] << 24) | (original[p + 4] << 16) | (original[p + 5] << 8) | original[p + 6]) >>> 0;
    for (const v of [outer + 1, 0xffffff, 100]) {
      const b = Uint8Array.from(original);
      setU32be(b, p + 3, v);
      expectReadsLike(b, "vp3", readVp3(original), readVp3);
    }
    const odd = Uint8Array.from(original);
    odd[p + 1] = 9; // 00 09 00 instead of 00 02 00
    expectReadsLike(odd, "vp3", readVp3(original), readVp3);
  });
  it("a short outer length does not excuse a cut file (colors3 cut at 483, fill cut at 6,058)", () => {
    for (const [name, cut] of [["colors3", 483], ["fill", 6058]] as const) {
      const b = Uint8Array.from(loadReference(name, "vp3").bytes);
      const q = 8 + ((b[6] << 8) | b[7]);
      b.set([0, 0, 0, 100], q + 3);
      expect(codeOf(() => readEmbroidery(b.slice(0, cut), "x.vp3")), name).toBe("corrupt");
    }
  });
});

describe("DST without the LA: header: padding after the END record", () => {
  // colors3.dst with its 512-byte header zeroed: detected from its records alone.
  const original = loadReference("colors3", "dst").bytes;
  const zeroHeader = (): Uint8Array => {
    const b = Uint8Array.from(original);
    b.fill(0, 0, 512);
    return b;
  };
  const withTail = (tail: number[]): Uint8Array => {
    const z = zeroHeader();
    const b = new Uint8Array(z.length + tail.length);
    b.set(z);
    b.set(tail, z.length);
    return b;
  };
  let seed = 99;
  const random = (n: number): number[] => Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);

  it("A1 00 00, 100 zero bytes, 0x1A or 37 random bytes after the END: read in full", () => {
    const full = toRefShape(readDst(zeroHeader()));
    for (const tail of [[0xa1, 0, 0], new Array(100).fill(0), [0x1a], random(37)]) {
      const b = withTail(tail);
      expect(detectFormat(b, "x.dst"), `tail ${tail.length}`).toBe("dst");
      expect(toRefShape(readEmbroidery(b, "x.dst")).stitches).toEqual(full.stitches);
    }
  });
  it("more padding than DST_MAX_TAIL (512 bytes) is not taken for a DST", () => {
    expect(codeOf(() => readEmbroidery(withTail(random(600)), "x.dst"))).toBe("unknown_format");
  });
  it("a tail is only accepted after DST_MIN_RECORDS_WITH_TAIL (8) records, so a few lucky random records do not pass", () => {
    // 2 stitch records and an END, then padding: too short a body to vouch for the bytes after it.
    const b = new Uint8Array(512 + 9 + 40);
    b.set([0x01, 0x01, 0x03, 0x02, 0x02, 0x03, 0x00, 0x00, 0xf3], 512);
    b.set(random(40), 521);
    expect(detectFormat(b, "x.dst")).toBeNull();
    expect(detectFormat(b.slice(0, 521), "x.dst")).toBe("dst"); // without the tail it is a (tiny) DST
  });
  it("cut inside its records, it is still corrupt", () => {
    const b = zeroHeader();
    for (const cut of [515, 600, b.length - 3, b.length - 1]) {
      expect(codeOf(() => readEmbroidery(b.slice(0, cut), "x.dst")), `cut at ${cut}`).toBe("corrupt");
    }
  });
});
