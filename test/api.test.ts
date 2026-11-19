import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EmbPattern, EmbThread, EmbroideryReadError, EmbroideryWriteError, MAX_BYTES, MAX_STITCHES, WARNING_MESSAGES,
  HOOP_MESSAGES, convert, conversionWarnings, detectFormat, readEmbroidery, readPes, readVp3, readDst, readExp, readJef,
  writeEmbroidery, writeJef, writePes, writeDst, writeExp, writeVp3,
  type Format,
} from "../src/index";
import { estimateEncodedStitches, toAscii } from "../src/api";
import { INKSTITCH_EXPORT_SETTINGS, effectiveSettings } from "../src/core/settings";
import { normalize } from "../src/core/encoder";
import { fromJson, corpusPath, itPy, pythonWrite, toRefShape, type RefDump } from "./helpers/parity";

const FORMATS: Format[] = ["pes", "dst", "jef", "exp", "vp3"];
const file = (name: string, ext: string): Uint8Array => new Uint8Array(readFileSync(corpusPath(name, ext)));
const json = (name: string): RefDump => JSON.parse(readFileSync(corpusPath(name, "json"), "utf8")) as RefDump;
const pattern = (name: string): EmbPattern => fromJson(json(name));
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? `other:${String(e)}`; }
  return "none";
};
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
function line(points: number, step = 5): EmbPattern {
  const p = new EmbPattern();
  p.addThread(new EmbThread(0xff0000));
  for (let i = 0; i < points; i++) p.stitchAbs(i * step, 0);
  p.end();
  return p;
}

describe("read errors", () => {
  it("zero-byte file is empty", () => expect(codeOf(() => readEmbroidery(new Uint8Array(0), "a.pes"))).toBe("empty"));
  it("random bytes and PNG are unknown_format", () => {
    const rnd = Uint8Array.from({ length: 300 }, (_, i) => (i * 97 + 31) & 0xff | 0x80);
    expect(codeOf(() => readEmbroidery(rnd))).toBe("unknown_format");
    expect(codeOf(() => readEmbroidery(PNG))).toBe("unknown_format");
  });
  it("PNG/JPEG/GIF/PDF/ZIP/text named .dst/.exp/.jef are unknown_format", () => {
    const foreign = [PNG, Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46), text("GIF89a......"), text("%PDF-1.7 blah"),
      Uint8Array.of(0x50, 0x4b, 3, 4, 20, 0, 0, 0), text("hello this is just a note\r\nabout stitches\r\n")];
    for (const b of foreign) for (const ext of ["dst", "exp", "jef"]) {
      expect(codeOf(() => readEmbroidery(b, `x.${ext}`))).toBe("unknown_format");
    }
  });
  it("truncated PES (200 bytes) is corrupt and fast", () => {
    const t0 = performance.now();
    expect(codeOf(() => readEmbroidery(file("colors3", "pes").slice(0, 200), "x.pes"))).toBe("corrupt");
    expect(performance.now() - t0).toBeLessThan(100);
  });
  it("a full truncation sweep: every cut length of colors3 and fill is corrupt, except exact record boundaries", () => {
    /** Independent EXP walk: the lengths at which a cut lands on a record boundary. */
    const expBoundaries = (b: Uint8Array): Set<number> => {
      const ok = new Set<number>();
      let i = 0;
      while (i < b.length) {
        i += b[i] === 0x80 ? 4 : 2;
        if (i <= b.length) ok.add(i);
      }
      return ok;
    };
    for (const name of ["colors3", "fill"]) for (const ext of FORMATS) {
      const full = file(name, ext);
      const boundaries = ext === "exp" ? expBoundaries(full) : new Set<number>();
      for (let n = 1; n < full.length; n++) {
        const code = codeOf(() => readEmbroidery(full.slice(0, n), `x.${ext}`));
        if (boundaries.has(n)) expect(code, `${name}.${ext}@${n}`).toBe("none");
        else expect(code, `${name}.${ext}@${n}`).toBe("corrupt");
      }
      expect(codeOf(() => readEmbroidery(full, `x.${ext}`))).toBe("none");
    }
  });
  it("a PES v6 file cut inside the trailing colour addendum still has all its stitches (v6 files from other software lack that tail)", () => {
    const full = file("colors3", "v6.pes");
    const cut = readEmbroidery(full.slice(0, full.length - 10), "x.pes");
    expect(cut.stitches.length).toBe(readEmbroidery(full, "x.pes").stitches.length);
  });
  it("the integrity checks never reject our own writers (9 patterns x 5 formats + PES v6)", () => {
    const names = readdirSync(corpusPath("lines", "json").replace(/lines\.json$/, "")).filter((f) => f.endsWith(".json") && !f.includes(".dump.") && !f.includes(".normalized.")).map((f) => f.replace(/\.json$/, ""));
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const p = pattern(name);
      for (const f of FORMATS) {
        const bytes = writeEmbroidery(p, f);
        expect(codeOf(() => readEmbroidery(bytes, `x.${f}`)), `${name} -> ${f}`).toBe("none");
      }
      expect(codeOf(() => readEmbroidery(writeEmbroidery(p, "pes", { pesVersion: 6 }), "x.pes")), `${name} -> v6`).toBe("none");
    }
  });
  it("no corpus file (any format, including v6.pes) is rejected", () => {
    const dir = corpusPath("lines", "json").replace(/lines\.json$/, "");
    let n = 0;
    for (const f of readdirSync(dir)) {
      const m = /\.(pes|dst|jef|exp|vp3)$/.exec(f);
      if (!m) continue;
      n++;
      expect(codeOf(() => readEmbroidery(new Uint8Array(readFileSync(dir + f)), `x.${m[1]}`)), f).toBe("none");
    }
    expect(n).toBeGreaterThan(40);
  });
  it("a zero-stitch result from non-empty input is corrupt", () => {
    expect(codeOf(() => readEmbroidery(text("LA:Untitled        \r"), "x.dst"))).toBe("corrupt");
  });
  it("over MAX_BYTES is too_large", () => {
    expect(codeOf(() => readEmbroidery(new Uint8Array(MAX_BYTES + 1), "x.dst"))).toBe("too_large");
  });
  it("a DST that would decode to more than MAX_STITCHES is too_large", () => {
    const b = new Uint8Array(512 + 3 * (MAX_STITCHES + 10));
    b.set(text("LA:big"), 0);
    expect(codeOf(() => readEmbroidery(b, "big.dst"))).toBe("too_large");
  });
  it("reads good files", () => {
    for (const ext of FORMATS) expect(readEmbroidery(file("colors3", ext), `x.${ext}`).stitches.length).toBeGreaterThan(0);
  });
});

describe("detectFormat", () => {
  it("DST bytes named x.pes are dst; magic beats extension for every format", () => {
    expect(detectFormat(file("colors3", "dst"), "x.pes")).toBe("dst");
    expect(detectFormat(file("colors3", "pes"), "x.dst")).toBe("pes");
    expect(detectFormat(file("colors3", "v6.pes"), "x.jef")).toBe("pes");
    expect(detectFormat(file("colors3", "vp3"), "x.exp")).toBe("vp3");
    expect(detectFormat(text("#PEC0001 rest"), "x.dst")).toBe("pes");
  });
  it("extension is case-insensitive and used when there is no magic", () => {
    expect(detectFormat(file("colors3", "pes"), "DESIGN.PES")).toBe("pes");
    expect(detectFormat(file("colors3", "exp"), "A.EXP")).toBe("exp");
    expect(detectFormat(file("colors3", "jef"), "a.Jef")).toBe("jef");
  });
  it("no extension and no magic gives null", () => {
    expect(detectFormat(file("colors3", "exp"))).toBeNull();
    expect(detectFormat(file("colors3", "exp"), "noext")).toBeNull();
  });
});

describe("writeEmbroidery", () => {
  it("zero-stitch pattern is empty_design for all five formats", () => {
    for (const f of FORMATS) expect(codeOf(() => writeEmbroidery(new EmbPattern(), f))).toBe("empty_design");
  });
  it("a pattern with only jumps and END is empty_design", () => {
    const p = new EmbPattern();
    p.moveAbs(10, 10); p.end();
    for (const f of FORMATS) expect(codeOf(() => writeEmbroidery(p, f))).toBe("empty_design");
  });
  it("PES version other than 1 or 6 is unsupported_option", () => {
    expect(codeOf(() => writeEmbroidery(pattern("colors3"), "pes", { pesVersion: 3 as 1 }))).toBe("unsupported_option");
    expect(writeEmbroidery(pattern("colors3"), "pes", { pesVersion: 6 }).length).toBeGreaterThan(0);
  });
  it("pesVersion 1 is the default and matches pystitch bytes", () => {
    expect(Buffer.from(writeEmbroidery(pattern("colors3"), "pes")).equals(Buffer.from(file("colors3", "pes")))).toBe(true);
  });
  it("more than 256 colours into PES is too_many_colors (both versions); other formats still write", () => {
    const p = new EmbPattern();
    for (let i = 0; i < 300; i++) {
      p.addThread(new EmbThread((i * 5000) & 0xffffff));
      p.stitchAbs(i * 4, 0);
      p.stitchAbs(i * 4 + 2, 3);
      if (i < 299) p.colorChange();
    }
    p.end();
    expect(codeOf(() => writeEmbroidery(p, "pes"))).toBe("too_many_colors");
    expect(codeOf(() => writeEmbroidery(p, "pes", { pesVersion: 6 }))).toBe("too_many_colors");
    expect(writeEmbroidery(p, "jef").length).toBeGreaterThan(0);
  });
  it("huge coordinates are too_large before any allocation, for every format", () => {
    const p = new EmbPattern();
    p.stitchAbs(0, 0);
    p.stitchAbs(20_000_000_000, 0);
    p.end();
    const t0 = performance.now();
    for (const f of FORMATS) expect(codeOf(() => writeEmbroidery(p, f))).toBe("too_large");
    expect(performance.now() - t0).toBeLessThan(500);
    const nan = new EmbPattern();
    nan.stitchAbs(0, 0);
    nan.stitchAbs(Number.NaN, 0);
    expect(codeOf(() => writeEmbroidery(nan, "dst"))).toBe("write_failed");
    expect(() => writeEmbroidery(nan, "dst")).toThrow(/invalid coordinates/);
  });
  it("a 1,000,001-stitch pattern is too_large", () => {
    expect(codeOf(() => writeEmbroidery(line(MAX_STITCHES + 1, 1), "dst"))).toBe("too_large");
  });
  it("an ordinary design is not refused by the estimate", () => {
    expect(writeEmbroidery(line(50_000, 3), "dst").length).toBeGreaterThan(0);
  });
  it("any other writer failure is write_failed", () => {
    const p = line(5);
    p.metadata("name", 42); // PEC/DST name must be text
    expect(codeOf(() => writeEmbroidery(p, "pes"))).toBe("write_failed");
  });
  it("write errors are EmbroideryWriteError with a message", () => {
    expect(() => writeEmbroidery(new EmbPattern(), "dst")).toThrow(EmbroideryWriteError);
    expect(() => writeEmbroidery(new EmbPattern(), "dst")).toThrow(/no stitches/);
  });
  it("null options are treated as no options", () => {
    expect(writeEmbroidery(pattern("colors3"), "pes", null as unknown as undefined).length).toBeGreaterThan(0);
  });
});

describe("non-ASCII metadata", () => {
  function accented(): EmbPattern {
    const p = line(20);
    p.metadata("name", "Café Ünïcode 花");
    p.threads[0].description = "Rouge écarlate 红";
    p.threads[0].brand = "Müller";
    p.threads[0].catalogNumber = "№ 12";
    return p;
  }
  it("VP3 and PES v6 write something readable back, ASCII-folded, and the caller's pattern is unchanged", () => {
    const p = accented();
    const before = JSON.stringify({ e: p.extras, t: p.threads.map((t) => [t.description, t.brand, t.catalogNumber]) });
    const vp3 = readVp3(writeEmbroidery(p, "vp3"));
    expect(vp3.stitches.length).toBeGreaterThan(0);
    expect(vp3.threads[0].description ?? "").toMatch(/^[\x20-\x7e]*$/);
    const pes = readPes(writeEmbroidery(p, "pes", { pesVersion: 6 }));
    expect(pes.stitches.length).toBeGreaterThan(0);
    expect(pes.threads[0].description).toBe("Rouge ecarlate ");
    expect(pes.threads[0].brand).toBe("Muller");
    expect(pes.getMetadata("name")).toBe("Cafe Unicode ");
    expect(JSON.stringify({ e: p.extras, t: p.threads.map((t) => [t.description, t.brand, t.catalogNumber]) })).toBe(before);
    expect(p.threads[0].description).toBe("Rouge écarlate 红");
  });
  it("DST header name stays readable", () => {
    const d = readDst(writeEmbroidery(accented(), "dst"));
    expect(d.getMetadata("name")).toMatch(/^[\x20-\x7e]*$/);
    expect(d.stitches.length).toBeGreaterThan(0);
  });
});

describe("conversionWarnings", () => {
  const codes = (p: EmbPattern, to: Format): string[] => conversionWarnings(p, to).map((w) => w.code);
  it("colors_dropped for DST and EXP only when the source has threads", () => {
    expect(codes(pattern("colors3"), "dst")).toContain("colors_dropped");
    expect(codes(pattern("colors3"), "exp")).toContain("colors_dropped");
    expect(codes(pattern("colors3"), "vp3")).not.toContain("colors_dropped");
    const bare = line(5);
    bare.threads = [];
    expect(codes(bare, "dst")).not.toContain("colors_dropped");
  });
  it("palette_approximated for off-palette colours; not for exact palette colours", () => {
    const off = line(10);
    off.threads = [new EmbThread(0x123457)];
    expect(codes(off, "jef")).toContain("palette_approximated");
    expect(codes(off, "pes")).toContain("palette_approximated");
    const exact = line(10);
    exact.threads = [new EmbThread(0x000000), new EmbThread(0xffffff)];
    expect(codes(exact, "jef")).not.toContain("palette_approximated");
    expect(codes(off, "dst")).not.toContain("palette_approximated");
  });
  it("PES-read colours carry an alpha byte but exact palette colours are not flagged", () => {
    const p = readEmbroidery(file("colors3", "pes"), "x.pes");
    expect(codes(p, "pes")).not.toContain("palette_approximated");
    const alpha = line(5);
    alpha.threads = [new EmbThread(0xff000000)];
    expect(codes(alpha, "jef")).not.toContain("palette_approximated");
  });
  it("many_colors when blocks exceed the palette (120 into JEF's 78)", () => {
    const p = pattern("colors120");
    expect(codes(p, "jef")).toContain("many_colors");
    expect(codes(p, "pes")).toContain("many_colors");
    expect(codes(p, "vp3")).not.toContain("many_colors");
    expect(codes(pattern("colors3"), "jef")).not.toContain("many_colors");
  });
  const sized = (w: number, h: number, x0 = 0, y0 = 0): EmbPattern => {
    const p = new EmbPattern();
    p.stitchAbs(x0, y0); p.stitchAbs(x0 + w, y0); p.stitchAbs(x0 + w, y0 + h); p.end();
    return p;
  };
  it("JEF exceeds_hoop uses the real size: 140x200 fits, 200 mm and 400x400 do not", () => {
    expect(codes(sized(1400, 1999), "jef")).not.toContain("exceeds_hoop");
    expect(codes(sized(1999, 1999), "jef")).not.toContain("exceeds_hoop");
    expect(codes(sized(2000, 100), "jef")).toContain("exceeds_hoop");
    expect(codes(sized(4000, 4000), "jef")).toContain("exceeds_hoop");
    expect(codes(sized(4000, 4000), "dst")).not.toContain("exceeds_hoop");
    expect(conversionWarnings(sized(4000, 4000), "jef").find((w) => w.code === "exceeds_hoop")?.message).toBe(HOOP_MESSAGES.jef);
  });
  it("hoop warnings use the exact bounds of the normalised pattern the writer sees", () => {
    const exact = (p: EmbPattern, to: "jef" | "pes"): [number, number] => {
      const [a, b, c, d] = normalize(p, effectiveSettings(to, INKSTITCH_EXPORT_SETTINGS)).bounds();
      return [c - a, d - b];
    };
    for (const [w, h, x0] of [[100, 100, 1950], [100, 100, 1800], [1500, 500, 600], [1700, 200, 5000], [100, 100, 0]] as const) {
      const p = sized(w, h, x0);
      const [nw, nh] = exact(p, "jef");
      expect(codes(p, "jef").includes("exceeds_hoop"), `jef ${w}x${h}@${x0}`).toBe(nw >= 2000 || nh >= 2000);
      const [pw, ph] = exact(p, "pes");
      expect(codes(p, "pes").includes("exceeds_hoop"), `pes ${w}x${h}@${x0}`).toBe(Math.max(pw, ph) > 1800 || Math.min(pw, ph) > 1300);
    }
  });
  it("PES exceeds_hoop ignores orientation: 150x50 mm landscape is fine, bigger than both limits warns", () => {
    expect(codes(sized(1500, 500), "pes")).not.toContain("exceeds_hoop");
    expect(codes(sized(500, 1500), "pes")).not.toContain("exceeds_hoop");
    expect(codes(sized(1800, 1300), "pes")).not.toContain("exceeds_hoop");
    expect(codes(sized(1801, 100), "pes")).toContain("exceeds_hoop");
    expect(codes(sized(1400, 1400), "pes")).toContain("exceeds_hoop");
    expect(codes(sized(2500, 2000), "pes")).toContain("exceeds_hoop");
    expect(conversionWarnings(sized(2500, 2000), "pes").find((w) => w.code === "exceeds_hoop")?.message).toBe(HOOP_MESSAGES.pes);
  });
  it("the large corpus design into JEF warns, and the file is still written exactly as writeJef does", () => {
    const p = pattern("large");
    expect(codes(p, "jef")).toContain("exceeds_hoop");
    const mask = (b: Uint8Array): Buffer => { const c = Buffer.from(b); c.fill(0, 8, 22); return c; }; // the date stamp
    expect(mask(writeEmbroidery(p, "jef")).equals(mask(writeJef(p, INKSTITCH_EXPORT_SETTINGS)))).toBe(true);
  });
  it("every warning has a message from the table", () => {
    for (const w of conversionWarnings(pattern("colors120"), "jef")) {
      expect(w.message.length).toBeGreaterThan(10);
      expect(w.message).not.toMatch(/\{\w+\}/);
    }
    expect(Object.keys(WARNING_MESSAGES).sort()).toEqual(["colors_dropped", "exceeds_hoop", "many_colors", "palette_approximated", "stops_dropped"]);
    expect(conversionWarnings(pattern("colors3"), "dst")[0].message).toBe(
      "DST files don't store thread colours. Your machine will ask for colour changes, but the colours will be lost.");
  });
});

describe("convert", () => {
  it("names an unnamed design after the filename stem (DST header, 16 chars, ASCII), without mutating the pattern", () => {
    const head = (name: string) => new TextDecoder().decode(convert(file("colors3", "pes"), name, "dst").bytes.slice(0, 20));
    expect(head("my design (1).pes")).toMatch(/^LA:my design \(1\) /);
    expect(head("Tasarım ünlü çok uzun isim.PES").startsWith("LA:Tasarim unlu cok")).toBe(true);
    expect(head("Tasarım ünlü çok uzun isim.PES").slice(3, 19)).toBe("Tasarim unlu cok");
  });
  it("colors3.pes to dst warns and renames; Unicode and spaces are kept", () => {
    const r = convert(file("colors3", "pes"), "x.pes", "dst");
    expect(r.warnings.map((w) => w.code)).toContain("colors_dropped");
    expect(r.outName).toBe("x.dst");
    expect(convert(file("colors3", "dst"), "my design (1).dst", "pes").outName).toBe("my design (1).pes");
    expect(convert(file("colors3", "dst"), "Tasarım ünlü.DST", "pes").outName).toBe("Tasarım ünlü.pes");
    expect(convert(file("colors3", "dst"), "DESIGN.PES", "jef").outName).toBe("DESIGN.jef");
    expect(convert(file("colors3", "dst"), "noext", "vp3").outName).toBe("noext.vp3");
    expect(convert(file("colors3", "dst"), "v1.2 final", "vp3").outName).toBe("v1.2 final.vp3");
  });
  it("round-trips all 20 ordered pairs, and same-format works too", () => {
    for (const from of FORMATS) for (const to of FORMATS) {
      const r = convert(file("colors3", from), `c.${from}`, to);
      const back = readEmbroidery(r.bytes, r.outName);
      expect(back.stitches.length, `${from}->${to}`).toBeGreaterThan(0);
    }
  });
  it("PES v6 option flows through convert", () => {
    const r = convert(file("colors3", "dst"), "c.dst", "pes", { pesVersion: 6 });
    expect(new TextDecoder().decode(r.bytes.slice(0, 8))).toBe("#PES0060");
    expect(new TextDecoder().decode(convert(file("colors3", "dst"), "c.dst", "pes").bytes.slice(0, 8))).toBe("#PES0001");
  });
  it("bad input throws EmbroideryReadError", () => {
    expect(codeOf(() => convert(PNG, "a.dst", "pes"))).toBe("unknown_format");
  });
});

describe("detection of mislabelled and foreign files", () => {
  const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const pad = (head: number[], n = 4000): Uint8Array => { const b = new Uint8Array(n); b.set(head, 0); for (let i = head.length; i < n; i++) b[i] = (i * 37 + 11) & 0xff; return b; };
  const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
  const bmp = (() => { const b = pad([0x42, 0x4d], 3000); new DataView(b.buffer).setUint32(2, 3000, true); new DataView(b.buffer).setUint32(6, 0, true); new DataView(b.buffer).setUint32(14, 40, true); return b; })();
  const foreign: Record<string, Uint8Array> = {
    heic: pad([0, 0, 0, 0x18, ...ascii("ftypheic")]),
    mp4: pad([0, 0, 0, 0x20, ...ascii("ftypisom")]),
    tiff: pad([0x49, 0x49, 0x2a, 0]),
    tiffBE: pad([0x4d, 0x4d, 0, 0x2a]),
    ico: pad([0, 0, 1, 0, 1, 0]),
    sevenZ: pad([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    rar: pad([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
    webp: pad([...ascii("RIFF"), ...be32(100), ...ascii("WEBP")]),
    bmp,
    utf8: text("Merhaba d\u00fcnya, bu bir not: \u015f\u011f\u0131\u00e7\u00f6 \u00fc \r\n".repeat(40)),
    utf8bom: Uint8Array.of(0xef, 0xbb, 0xbf, ...text("hello world, plain text with a BOM\n".repeat(20))),
    utf16: (() => { const t = "hello world in utf-16\n".repeat(30); const b = new Uint8Array(2 + t.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < t.length; i++) b[2 + i * 2] = t.charCodeAt(i); return b; })(),
    svg: text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0L10 10"/></svg>'),
    json: text('{"a": [1, 2, 3], "b": "c"}'),
    random: pad([], 3000),
  };
  it("none of them can be read as a .dst, .exp or .jef", () => {
    for (const [what, b] of Object.entries(foreign)) for (const ext of ["dst", "exp", "jef", "pes", "vp3"]) {
      if (what === "random" && ext === "exp") continue; // residual: random bytes can follow EXP's grammar
      expect(codeOf(() => readEmbroidery(b, `photo.${ext}`)), `${what}.${ext}`).toBe("unknown_format");
      expect(detectFormat(b, `PHOTO.${ext.toUpperCase()}`), `${what}.${ext}`).toBeNull();
    }
  });
  it("random bytes with an embroidery file name are unknown_format; with no name too", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const b = Uint8Array.from({ length: 700 }, (_, i) => ((i + 1) * (seed * 7919 + 13) + (i >> 3) * 31337) & 0xff);
      for (const ext of ["dst", "jef", "pes", "vp3"]) expect(codeOf(() => readEmbroidery(b, `r.${ext}`)), `${seed}.${ext}`).toBe("unknown_format");
      // EXP has no magic: random bytes that follow its record grammar may decode, but never as anything else.
      expect(["unknown_format", "none"]).toContain(codeOf(() => readEmbroidery(b, "r.exp")));
      expect(codeOf(() => readEmbroidery(b))).toBe("unknown_format");
    }
  });
  it("a real BMP-like or JSON-like name does not hide a real design: EXP/DST/JEF named with the wrong extension are detected by content", () => {
    expect(detectFormat(file("fill", "jef"), "x.dst")).toBe("jef");
    expect(detectFormat(file("fill", "jef"), "x.exp")).toBe("jef");
    for (const [from, as] of [["jef", "dst"], ["jef", "exp"], ["exp", "dst"], ["dst", "exp"], ["dst", "jef"], ["exp", "jef"]] as const) {
      const r = codeOf(() => readEmbroidery(file("fill", from), `x.${as}`));
      // Either read as what it really is, or refused: never decoded as the wrong format.
      if (r === "none") expect(detectFormat(file("fill", from), `x.${as}`)).toBe(from);
      else expect(["unknown_format", "corrupt"]).toContain(r);
    }
    expect(readEmbroidery(file("fill", "jef"), "x.dst").stitches.length).toBe(readJef(file("fill", "jef")).stitches.length);
  });
  it("an EXP named .dst is not decoded as DST", () => {
    expect(detectFormat(file("fill", "exp"), "x.dst")).not.toBe("dst");
    expect(codeOf(() => readEmbroidery(file("fill", "exp"), "x.dst"))).toBe("unknown_format");
  });
  it("real tiny files still work: single.exp (3 stitches, 6 bytes) and single.dst", () => {
    expect(readEmbroidery(file("single", "exp"), "single.exp").stitches.length).toBeGreaterThan(0);
    expect(readEmbroidery(file("single", "dst"), "single.dst").stitches.length).toBeGreaterThan(0);
  });
});

describe("the too_large estimate is an upper bound", () => {
  const trimmed = (n: number, step: number): EmbPattern => {
    const p = new EmbPattern();
    p.addThread(new EmbThread(0xff0000));
    for (let i = 0; i < n; i++) { p.stitchAbs((i % 100) * step, Math.floor(i / 100) * step); p.trim(); }
    p.end();
    return p;
  };
  const actual = (p: EmbPattern, f: Format): number => normalize(p, effectiveSettings(f, INKSTITCH_EXPORT_SETTINGS)).stitches.length;
  it("is at least the real encoded size for every corpus pattern and every format", () => {
    for (const name of ["lines", "fill", "colors3", "trims", "bigjump", "colors120", "single", "large", "negative"]) {
      for (const f of FORMATS) expect(estimateEncodedStitches(pattern(name), f), `${name} ${f}`).toBeGreaterThanOrEqual(actual(pattern(name), f));
    }
  });
  it("is at least the real size for random patterns with trims, jumps, stops and colour changes", () => {
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let t = 0; t < 30; t++) {
      const p = new EmbPattern();
      for (let i = 0; i < 20; i++) p.addThread(new EmbThread((i * 70001) & 0xffffff));
      for (let i = 0; i < 150; i++) {
        const x = Math.round((rnd() - 0.5) * (rnd() < 0.2 ? 6000 : 200));
        const y = Math.round((rnd() - 0.5) * (rnd() < 0.2 ? 6000 : 200));
        const r = rnd();
        if (r < 0.5) p.stitchAbs(x, y);
        else if (r < 0.65) p.moveAbs(x, y);
        else if (r < 0.8) p.trim();
        else if (r < 0.9) p.colorChange();
        else p.stop();
      }
      p.end();
      for (const f of FORMATS) expect(estimateEncodedStitches(p, f), `${t} ${f}`).toBeGreaterThanOrEqual(actual(p, f));
    }
  });
  it("470,000 trim-separated stitches are refused (they encode to about 1.4 million) before a huge file is written", () => {
    const p = trimmed(470_000, 50);
    expect(actual(p, "pes")).toBeGreaterThan(MAX_STITCHES);
    expect(estimateEncodedStitches(p, "pes")).toBeGreaterThan(MAX_STITCHES);
    for (const f of ["pes", "dst"] as const) expect(codeOf(() => writeEmbroidery(p, f))).toBe("too_large");
  });
  it("a design just under the limit is still accepted", () => {
    expect(writeEmbroidery(trimmed(5_000, 50), "pes").length).toBeGreaterThan(0);
  });
});

describe("hostile large inputs are refused quickly", () => {
  const hostile = (name: string, ext: Format, build: () => Uint8Array): void => {
    it(`${name} (~29 MB) is too_large in under 1500 ms`, () => {
      const b = build();
      expect(b.length).toBeGreaterThan(14_000_000);
      const t0 = performance.now();
      expect(codeOf(() => readEmbroidery(b, `x.${ext}`))).toBe("too_large");
      expect(performance.now() - t0).toBeLessThan(1500);
    });
  };
  const put24 = (b: Uint8Array, o: number, v: number): void => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; };
  hostile("EXP of tiny stitches", "exp", () => { const b = new Uint8Array(29 * 1024 * 1024); b.fill(0x01); return b; });
  hostile("JEF with a huge stitch run", "jef", () => {
    const base = file("colors3", "jef");
    const offset = new DataView(base.buffer, base.byteOffset).getUint32(0, true);
    const n = 28_000_000;
    const b = new Uint8Array(offset + n + 2);
    b.set(base.subarray(0, offset), 0);
    b.fill(0x01, offset, offset + n);
    b[b.length - 2] = 0x80; b[b.length - 1] = 0x10;
    new DataView(b.buffer).setUint32(28, n / 2 + 1, true);
    return b;
  });
  hostile("PES with a huge PEC stitch block", "pes", () => {
    const base = file("colors3", "pes");
    const dv = new DataView(base.buffer, base.byteOffset);
    const pec = dv.getUint32(8, true);
    const cc = base[pec + 48];
    const lenAt = pec + 3 + 16 + 0xf + 2 + 0xc + 1 + (cc + 1) + (0x1d0 - cc);
    const blockEnd = (base[lenAt] | (base[lenAt + 1] << 8) | (base[lenAt + 2] << 16)) - 5 + lenAt + 3;
    const n = 16_000_000;
    const tail = base.subarray(blockEnd);
    const head = base.subarray(0, lenAt + 3 + 15);
    const b = new Uint8Array(head.length + n + 1 + tail.length);
    b.set(head, 0);
    b.fill(0x03, head.length, head.length + n);
    b[head.length + n] = 0xff;
    b.set(tail, head.length + n + 1);
    put24(b, lenAt, n + 1 + 15 + 5);
    return b;
  });
  it("VP3 with a huge stitch block is refused quickly", () => {
    const base = file("colors3", "vp3");
    const n = 28_000_000;
    const b = new Uint8Array(base.length + n);
    // Insert n small stitches before the end of the first colour block and patch the three nested lengths.
    const dv = new DataView(b.buffer);
    const strLen = (base[6] << 8) | base[7];
    const outerAt = 8 + strLen + 3;
    const designAt = (() => { for (let i = outerAt; i < base.length - 3; i++) if (base[i] === 0 && base[i + 1] === 3 && base[i + 2] === 0) return i + 3; return -1; })();
    const blockAt = (() => { for (let i = designAt; i < base.length - 3; i++) if (base[i] === 0 && base[i + 1] === 5 && base[i + 2] === 0) return i + 3; return -1; })();
    const baseDv = new DataView(base.buffer, base.byteOffset);
    const blockLen = baseDv.getUint32(blockAt);
    const insertAt = blockAt + 4 + blockLen - 1; // before the block's closing byte
    b.set(base.subarray(0, insertAt), 0);
    b.fill(0x01, insertAt, insertAt + n);
    b.set(base.subarray(insertAt), insertAt + n);
    dv.setUint32(outerAt, baseDv.getUint32(outerAt) + n);
    dv.setUint32(designAt, baseDv.getUint32(designAt) + n);
    dv.setUint32(blockAt, blockLen + n);
    expect(detectFormat(b, "x.vp3")).toBe("vp3");
    const t0 = performance.now();
    const code = codeOf(() => readEmbroidery(b, "x.vp3"));
    expect(code).toBe("too_large");
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it("the stitch limit only applies when asked: readers without options are unlimited", () => {
    expect(readExp(new Uint8Array(2_000_000).fill(1)).stitches.length).toBeGreaterThan(900_000);
    expect(codeOf(() => readEmbroidery(new Uint8Array(2_100_000).fill(1), "x.exp"))).toBe("too_large");
  });
});

describe("colour edge cases and text", () => {
  it("300 threads with one block is written as PES (only used blocks count)", () => {
    const p = line(30);
    p.threads = Array.from({ length: 300 }, (_, i) => new EmbThread(i * 1000));
    expect(writeEmbroidery(p, "pes").length).toBeGreaterThan(0);
    expect(readEmbroidery(writeEmbroidery(p, "pes"), "x.pes").stitches.length).toBeGreaterThan(0);
  });
  it("many_colors counts distinct colours, not blocks", () => {
    const p = new EmbPattern();
    for (let i = 0; i < 100; i++) {
      p.addThread(new EmbThread(i % 2 ? 0xff0000 : 0x0000ff)); // 100 blocks, 2 colours
      p.stitchAbs(i * 4, 0); p.stitchAbs(i * 4 + 2, 3);
      if (i < 99) p.colorChange();
    }
    p.end();
    expect(conversionWarnings(p, "jef").map((w) => w.code)).not.toContain("many_colors");
    expect(conversionWarnings(pattern("colors120"), "jef").map((w) => w.code)).toContain("many_colors");
  });
  it("toAscii transliterates Turkish and Nordic letters instead of dropping them", () => {
    expect(toAscii("K\u0131rm\u0131z\u0131")).toBe("Kirmizi");
    expect(toAscii("\u0130stanbul")).toBe("Istanbul");
    expect(toAscii("Stra\u00dfe \u0141\u00f3d\u017a \u00d8re \u00c6ble \u0153uvre \u0111 \u00fe")).toBe("Strasse Lodz Ore AEble oeuvre d th");
    expect(toAscii("caf\u00e9 \u82b1")).toBe("cafe ");
  });
});

describe("trailing bytes, satin EXP, limits", () => {
  const cat = (a: Uint8Array, t: number[]): Uint8Array => { const b = new Uint8Array(a.length + t.length); b.set(a); b.set(t, a.length); return b; };
  const satin = (step: number): EmbPattern => {
    const p = new EmbPattern();
    p.addThread(new EmbThread(0xff0000));
    for (let i = 0; i < 60; i++) { p.stitchAbs(i * 2, i % 2 ? step : -step); }
    p.end();
    return p;
  };
  it("satin and long-stitch EXP written by us re-read, for every format that can hold them", () => {
    for (const step of [60, 110, 120, 127]) for (const f of FORMATS) {
      const bytes = writeEmbroidery(satin(step), f);
      expect(readEmbroidery(bytes, `s.${f}`).stitches.length, `${f} ${step}`).toBeGreaterThan(50);
    }
  });
  itPy("satin EXP written by pystitch re-reads", () => {
    for (const step of [110, 127]) {
      const bytes = pythonWrite(toRefShape(satin(step)), "exp");
      expect(readEmbroidery(bytes, "py.exp").stitches.length).toBeGreaterThan(50);
    }
  });
  it("complete files with trailing bytes still read in full", () => {
    const cases: Array<[Format, string, number[]]> = [
      ["dst", "fill", [0x1a]], ["dst", "fill", [0xa1, 0, 0]], ["dst", "fill", [0, 0, 0]],
      ["jef", "fill", [0, 0]], ["jef", "fill", [0x1a]], ["vp3", "fill", [0]], ["pes", "fill", [0]], ["pes", "fill", [0xff, 0, 0]],
    ];
    for (const [f, name, tail] of cases) {
      const full = file(name, f);
      const want = readEmbroidery(full, `x.${f}`).stitches.length;
      expect(readEmbroidery(cat(full, tail), `x.${f}`).stitches.length, `${f} + ${tail.join(",")}`).toBe(want);
    }
  });
  it("a DST with no END record is corrupt even when its length is a multiple of 3", () => {
    const full = file("fill", "dst");
    expect(codeOf(() => readEmbroidery(full.slice(0, full.length - 3), "x.dst"))).toBe("corrupt");
  });
  it("a JEF header claiming millions of colours is too_large, fast", () => {
    const b = file("colors3", "jef").slice();
    const dv = new DataView(b.buffer);
    dv.setUint32(24, 3_600_000, true);
    dv.setUint32(0, 0x74 + 8 * 3_600_000, true);
    const t0 = performance.now();
    expect(codeOf(() => readEmbroidery(b, "x.jef"))).toBe("too_large");
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it("a very long design name still gives a readable DST", () => {
    const p = line(20);
    p.metadata("name", "N".repeat(900));
    const out = writeEmbroidery(p, "dst");
    expect(out.length).toBeGreaterThanOrEqual(512);
    expect(readEmbroidery(out, "x.dst").stitches.length).toBeGreaterThan(5);
  });
  it("the returned pattern does not carry the reader's stitch limit; readers accept null options", () => {
    expect(readEmbroidery(file("colors3", "dst"), "x.dst").maxStitches).toBeNull();
    expect(readPes(file("colors3", "pes"), null).stitches.length).toBeGreaterThan(0);
    expect(readExp(file("colors3", "exp"), null).stitches.length).toBeGreaterThan(0);
    expect(readVp3(file("colors3", "vp3"), null).stitches.length).toBeGreaterThan(0);
  });
});

describe("stops_dropped warning", () => {
  /** colors3 with an applique-style stop: block 0, STOP, block 0 again (same thread), then the colour changes. */
  const withStop = (): RefDump => {
    const j = json("colors3");
    const s = j.stitches;
    j.stitches.splice(5, 0, [s[4][0], s[4][1], 3]);
    return j;
  };
  const stopsAndChanges = (d: { stitches: [number, number, number][] }): number => d.stitches.filter((s) => s[2] === 3 || s[2] === 5).length;

  itPy("pystitch keeps the stop in PES and JEF, makes it a colour change in DST and EXP, and drops it in VP3", () => {
    const j = withStop();
    const before = stopsAndChanges(j);
    const readers: Record<Format, (b: Uint8Array) => EmbPattern> = { pes: readPes, dst: readDst, jef: readJef, exp: readExp, vp3: readVp3 };
    for (const f of FORMATS) {
      const back = toRefShape(readers[f](pythonWrite(j, f)));
      expect(stopsAndChanges(back), f).toBe(f === "vp3" ? before - 1 : before);
    }
  });
  it("is the only warning a stop adds, and only for VP3", () => {
    const p = fromJson(withStop());
    for (const f of FORMATS) {
      const codes = conversionWarnings(p, f).map((w) => w.code);
      expect(codes.includes("stops_dropped"), f).toBe(f === "vp3");
      expect(codes.filter((c) => c !== "stops_dropped")).toEqual(conversionWarnings(pattern("colors3"), f).map((w) => w.code));
    }
    expect(conversionWarnings(p, "vp3").find((w) => w.code === "stops_dropped")?.message).toBe(
      "VP3 files can't store stops, so the pause for placing applique fabric will be lost. Convert to PES, DST or JEF instead, or add the stop on your machine.",
    );
  });
  itPy("the VP3 bytes stay pystitch's", () => {
    const j = withStop();
    expect(Buffer.from(writeEmbroidery(fromJson(j), "vp3")).equals(Buffer.from(pythonWrite(j, "vp3")))).toBe(true);
  });
  itPy("a PES whose stop pystitch reads back (same colour twice) warns when converted to VP3", () => {
    const pes = pythonWrite(withStop(), "pes");
    expect(readPes(pes).stitches.some((s) => s[2] === 3)).toBe(true);
    expect(convert(pes, "applique.pes", "vp3").warnings.map((w) => w.code)).toContain("stops_dropped");
    expect(convert(pes, "applique.pes", "jef").warnings.map((w) => w.code)).not.toContain("stops_dropped");
  });
});
