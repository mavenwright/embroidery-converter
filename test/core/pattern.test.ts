import { describe, expect, it } from "vitest";
import * as C from "../../src/core/constants";
import { EmbThread, FILLER_COLORS, findNearestColorIndex, colorDistanceRedMean, colorHex } from "../../src/core/thread";
import { EmbPattern } from "../../src/core/pattern";
import { decodeEmbroideryCommand, encodeThreadChange } from "../../src/core/functions";

describe("constants (verbatim from EmbConstant.py)", () => {
  it("has the pystitch values", () => {
    expect([C.STITCH, C.JUMP, C.TRIM, C.STOP, C.END, C.COLOR_CHANGE, C.NEEDLE_SET]).toEqual([0, 1, 2, 3, 4, 5, 9]);
    expect([C.SEQUIN_MODE, C.SEQUIN_EJECT, C.SLOW, C.FAST]).toEqual([6, 7, 0xb, 0xc]);
    expect(C.COMMAND_MASK).toBe(0xff);
    expect(C.NO_COMMAND).toBe(-1);
    expect(C.COLOR_BREAK).toBe(0xe2);
    expect(C.TIE_OFF).toBe(0xe5);
    expect(C.SEQUENCE_BREAK).toBe(0xe1);
    expect(C.ORDER_MASK).toBe(0xff000000);
  });
});

describe("EmbThread", () => {
  it("parses colours and formats hex", () => {
    expect(new EmbThread("#ff8000").color).toBe(0xff8000);
    expect(new EmbThread("#f80").color).toBe(0xff8800);
    expect(new EmbThread("Red").color).toBe(0xff0000);
    expect(new EmbThread(0x0a0b0c).hexColor()).toBe("#0a0b0c");
    expect(colorHex("#12345678")).toBe(0x123456);
    expect(colorHex("12")).toBeUndefined();
  });
  it("throws like pystitch on unknown colour names", () => {
    expect(() => new EmbThread("notacolour")).toThrow();
  });
  it("accepts dict-style input", () => {
    const t = new EmbThread({ name: "Sky", rgb: [1, 2, 3], id: "42", manufacturer: "Madeira" });
    expect(t.color).toBe(0x010203);
    expect(t.description).toBe("Sky");
    expect(t.catalogNumber).toBe("42");
    expect(t.brand).toBe("Madeira");
  });
  it("equals compares all attributes; number/string compare colour only", () => {
    const a = new EmbThread(0xff0000, "a");
    expect(a.equals(new EmbThread(0xff0000, "a"))).toBe(true);
    expect(a.equals(new EmbThread(0xff0000, "b"))).toBe(false);
    expect(a.equals(0xff0000)).toBe(true);
    expect(a.equals("#ff0000")).toBe(true);
    expect(a.equals(null)).toBe(false);
  });
  it("findNearestColorIndex uses red-mean distance, ties pick the later entry", () => {
    expect(findNearestColorIndex(0xff0000, [0x000000, 0xfe0101])).toBe(1);
    expect(findNearestColorIndex(0x123456, [0x123456, 0x123456])).toBe(1);
    expect(findNearestColorIndex(0xff0000, [null, null])).toBeNull();
    expect(findNearestColorIndex(new EmbThread(0x0000ff), [null, new EmbThread(0x0000fe)])).toBe(1);
  });
  it("distance rounds half to even like Python round()", () => {
    // (1+2)/2 = 1.5 -> 2 in Python; (2+3)/2 = 2.5 -> 2 in Python (not 3)
    expect(colorDistanceRedMean(1, 0, 0, 2, 0, 0)).toBe(((512 + 2) * 1) >> 8);
    expect(colorDistanceRedMean(2, 0, 0, 3, 0, 0)).toBe(((512 + 2) * 1) >> 8);
    expect(colorDistanceRedMean(0, 0, 0, 255, 255, 255)).toBe(
      ((512 + 128) * 255 * 255 >> 8) + 4 * 255 * 255 + ((767 - 128) * 255 * 255 >> 8),
    );
  });
});

function sample(): EmbPattern {
  const p = new EmbPattern();
  p.addStitchAbsolute(C.STITCH, 0, 0);
  p.addStitchAbsolute(C.STITCH, 100, -50);
  p.addStitchAbsolute(C.STITCH, 30, 20);
  return p;
}

describe("EmbPattern basics", () => {
  it("bounds()", () => {
    expect(sample().bounds()).toEqual([0, -50, 100, 20]);
  });
  it("bounds() of an empty pattern is inf/-inf like pystitch", () => {
    expect(new EmbPattern().bounds()).toEqual([Infinity, Infinity, -Infinity, -Infinity]);
  });
  it("addStitchRelative accumulates from the previous position", () => {
    const p = new EmbPattern();
    p.addStitchRelative(C.JUMP, 5, 6);
    p.addStitchRelative(C.STITCH, -2, 4);
    expect(p.stitches).toEqual([[5, 6, C.JUMP], [3, 10, C.STITCH]]);
  });
  it("countColorChanges / countStitchCommands mask the command", () => {
    const p = sample();
    p.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    p.addStitchAbsolute(C.COLOR_CHANGE | 0x0300, 0, 0);
    p.addStitchAbsolute(C.STITCH, 1, 1);
    expect(p.countColorChanges()).toBe(2);
    expect(p.countStitchCommands(C.STITCH)).toBe(4);
    expect(p.countStitches()).toBe(6);
  });
  it("addThread accepts EmbThread or raw values", () => {
    const p = new EmbPattern();
    p.addThread(0xff0000);
    p.addThread("#00ff00");
    p.addThread(new EmbThread(0x0000ff));
    expect(p.threads.map((t) => t.color)).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
    expect(p.countThreads()).toBe(3);
  });
  it("copy constructor is shallow like pystitch", () => {
    const p = sample();
    p.extras["name"] = "x";
    const q = new EmbPattern(p);
    expect(q.stitches).toEqual(p.stitches);
    expect(q.stitches).not.toBe(p.stitches);
    expect(q.stitches[0]).toBe(p.stitches[0]);
    expect(q.extras).toEqual({ name: "x" });
  });
});

describe("fixColorCount", () => {
  it("pads threads to colourChanges+1", () => {
    const p = sample();
    p.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    p.addStitchAbsolute(C.STITCH, 5, 5);
    p.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    p.addStitchAbsolute(C.STITCH, 6, 6);
    p.addThread(0x112233);
    p.fixColorCount();
    expect(p.threads.length).toBe(p.countColorChanges() + 1);
    expect(p.threads[0].color).toBe(0x112233);
  });
  it("does not count a colour for a pattern with no stitches", () => {
    const p = new EmbPattern();
    p.addStitchAbsolute(C.JUMP, 1, 1);
    p.fixColorCount();
    expect(p.threads.length).toBe(0);
  });
  it("does not add a thread for a trailing colour change with no stitches", () => {
    const p = sample();
    p.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    p.fixColorCount();
    expect(p.threads.length).toBe(1);
  });
});

describe("deterministic filler threads", () => {
  function threeBlocks(): EmbPattern {
    const p = new EmbPattern();
    p.addStitchAbsolute(C.STITCH, 0, 0);
    p.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    p.addStitchAbsolute(C.STITCH, 1, 1);
    p.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    p.addStitchAbsolute(C.STITCH, 2, 2);
    return p;
  }
  it("fixColorCount pads 0 threads with FILLER_COLORS[0..2], repeatably", () => {
    const a = threeBlocks();
    a.fixColorCount();
    expect(a.threads.map((t) => t.color)).toEqual(FILLER_COLORS.slice(0, 3));
    expect(a.threads.every((t) => t.description === "Random")).toBe(true);
    const b = threeBlocks();
    b.fixColorCount();
    expect(b.threads.map((t) => t.color)).toEqual(a.threads.map((t) => t.color));
    a.fixColorCount();
    expect(a.threads.length).toBe(3);
  });
  it("getThreadOrFiller wraps around the filler table", () => {
    const p = new EmbPattern();
    expect(p.getThreadOrFiller(13).color).toBe(FILLER_COLORS[1]);
  });
});

describe("interpolateStopAsDuplicateColor", () => {
  it("turns STOP into COLOR_CHANGE and duplicates the thread", () => {
    const p = sample();
    p.addStitchAbsolute(C.STOP, 0, 0);
    p.addStitchAbsolute(C.STITCH, 9, 9);
    p.addThread(0xaa0000);
    p.addThread(0x00bb00);
    p.interpolateStopAsDuplicateColor();
    expect(p.threads.map((t) => t.color)).toEqual([0xaa0000, 0xaa0000, 0x00bb00]);
    expect(p.stitches[3][2]).toBe(C.COLOR_CHANGE);
  });
  it("returns silently when there is no thread to duplicate", () => {
    const p = sample();
    p.addStitchAbsolute(C.STOP, 0, 0);
    p.interpolateStopAsDuplicateColor();
    expect(p.stitches[3][2]).toBe(C.STOP);
  });
});

describe("getAsStitchblock / getAsColorblocks", () => {
  function two(): EmbPattern {
    const p = new EmbPattern();
    p.addThread(0xff0000);
    p.addThread(0x00ff00);
    p.addStitchAbsolute(C.STITCH, 0, 0);
    p.addStitchAbsolute(C.STITCH, 1, 1);
    p.addStitchAbsolute(C.JUMP, 2, 2);
    p.addStitchAbsolute(C.STITCH, 3, 3);
    p.addStitchAbsolute(C.COLOR_CHANGE, 3, 3);
    p.addStitchAbsolute(C.STITCH, 4, 4);
    p.addStitchAbsolute(C.END, 4, 4);
    return p;
  }
  it("stitchblocks split on any non-stitch command and advance thread on colour change", () => {
    const blocks = [...two().getAsStitchblock()];
    expect(blocks.map(([b, t]) => [b.length, t.color])).toEqual([
      [2, 0xff0000],
      [1, 0xff0000],
      [1, 0x00ff00],
    ]);
  });
  it("colourblocks end with the colour change and pair threads in order", () => {
    const blocks = [...two().getAsColorblocks()];
    expect(blocks.length).toBe(2);
    expect(blocks[0][0].length).toBe(5);
    expect(blocks[0][0][4][2]).toBe(C.COLOR_CHANGE);
    expect(blocks[0][1].color).toBe(0xff0000);
    expect(blocks[1][0].length).toBe(2);
    expect(blocks[1][1].color).toBe(0x00ff00);
  });
  it("COLOR_BREAK is omitted from blocks; NEEDLE_SET starts the next block", () => {
    const p = new EmbPattern();
    p.addThread(0x010101);
    p.addThread(0x020202);
    p.addThread(0x030303);
    p.addStitchAbsolute(C.STITCH, 0, 0);
    p.addStitchAbsolute(C.COLOR_BREAK, 0, 0);
    p.addStitchAbsolute(C.NEEDLE_SET, 0, 0);
    p.addStitchAbsolute(C.STITCH, 1, 1);
    const blocks = [...p.getAsColorblocks()];
    expect(blocks.map(([b]) => b.map((s) => s[2]))).toEqual([[C.STITCH], [C.NEEDLE_SET, C.STITCH]]);
    expect(blocks.map(([, t]) => t.color)).toEqual([0x010101, 0x020202]);
  });
  it("uses a filler thread when the thread list is short", () => {
    const p = new EmbPattern();
    p.addStitchAbsolute(C.STITCH, 0, 0);
    const [[, t]] = [...p.getAsColorblocks()];
    expect(t).toBeInstanceOf(EmbThread);
    expect(t.description).toBe("Random");
  });
});

describe("getAsCommandBlocks, metadata, translate", () => {
  it("groups runs of equal commands", () => {
    const p = new EmbPattern();
    for (const c of [C.STITCH, C.STITCH, C.JUMP, C.STITCH]) p.addStitchAbsolute(c, 0, 0);
    expect([...p.getAsCommandBlocks()].map((b) => b.length)).toEqual([2, 1, 1]);
  });
  it("metadata round-trips via extras", () => {
    const p = new EmbPattern();
    p.metadata("name", "n");
    expect(p.getMetadata("name")).toBe("n");
    expect(p.getMetadata("nope", 7)).toBe(7);
    expect(p.extras).toEqual({ name: "n" });
  });
  it("moveCenterToOrigin uses Python's round-half-even", () => {
    const p = new EmbPattern();
    p.addStitchAbsolute(C.STITCH, 0, 0);
    p.addStitchAbsolute(C.STITCH, 5, 5); // centre 2.5 -> 2 (Python), not 3
    p.moveCenterToOrigin();
    expect(p.stitches).toEqual([[-2, -2, C.STITCH], [3, 3, C.STITCH]]);
  });
});

describe("insert / relative insert", () => {
  it("insertStitchRelative handles start, middle and end", () => {
    const p = new EmbPattern();
    p.addStitchAbsolute(C.STITCH, 10, 10);
    p.addStitchAbsolute(C.STITCH, 20, 20);
    p.insertStitchRelative(0, C.JUMP, 1, 2);
    p.insertStitchRelative(2, C.TRIM, 3, 4);
    p.insertStitchRelative(-1, C.STOP, 5, 6);
    expect(p.stitches).toEqual([
      [1, 2, C.JUMP],
      [10, 10, C.STITCH],
      [13, 14, C.TRIM],
      [18, 20, C.STOP],
      [20, 20, C.STITCH],
    ]);
  });
});

describe("addPattern / duplicate colour as stop", () => {
  it("merges equal boundary colours and strips END", () => {
    const a = new EmbPattern();
    a.addThread(0xff0000);
    a.addStitchAbsolute(C.STITCH, 0, 0);
    a.addStitchAbsolute(C.END, 0, 0);
    const b = new EmbPattern();
    b.addThread(0xff0000);
    b.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    b.addStitchAbsolute(C.STITCH, 1, 1);
    a.addPattern(b);
    expect(a.threads.length).toBe(1);
    expect(a.stitches.map((s) => s[2])).toEqual([C.STITCH, C.NO_COMMAND, C.STITCH]);
  });
  it("interpolateDuplicateColorAsStop folds same-colour changes into STOP", () => {
    const p = new EmbPattern();
    p.addThread(0xff0000);
    p.addThread(0xff0000);
    p.addStitchAbsolute(C.STITCH, 0, 0);
    p.addStitchAbsolute(C.COLOR_CHANGE, 0, 0);
    p.addStitchAbsolute(C.STITCH, 1, 1);
    p.interpolateDuplicateColorAsStop();
    expect(p.threads.length).toBe(1);
    expect(p.stitches[1][2]).toBe(C.STOP);
  });
});

describe("thread change encoding", () => {
  it("round-trips needle numbers and keeps a positive 32-bit command", () => {
    const cmd = encodeThreadChange(C.NEEDLE_SET, null, 3, 200);
    expect(cmd).toBeGreaterThan(0);
    expect(decodeEmbroideryCommand(cmd)).toEqual([C.NEEDLE_SET, null, 3, 200]);
    expect(decodeEmbroideryCommand(C.STITCH)).toEqual([0, null, null, null]);
  });
  it("needleChange adds the encoded command", () => {
    const p = new EmbPattern();
    p.needleChange(2, 1, 1);
    expect(p.stitches[0][2] & C.COMMAND_MASK).toBe(C.NEEDLE_SET);
    expect(decodeEmbroideryCommand(p.stitches[0][2])[2]).toBe(2);
  });
});

describe("getNormalizedPattern", () => {
  it("runs the encoder (parity is covered in encoder.test.ts)", () => {
    const p = new EmbPattern();
    p.addThread(0xff0000);
    p.addStitchAbsolute(C.STITCH, 0, 0);
    p.addStitchAbsolute(C.STITCH, 300, 0);
    const n = p.getNormalizedPattern({ max_stitch: 121, max_jump: 121, round: true });
    expect(n.stitches).toEqual([[0, 0, C.STITCH], [100, 0, C.JUMP], [200, 0, C.JUMP], [300, 0, C.STITCH], [300, 0, C.END]]);
    expect(n.threads).toEqual([p.threads[0]]);
    expect(p.stitches.length).toBe(2);
  });
});
