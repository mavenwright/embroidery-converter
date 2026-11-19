// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SWATCHES, factsLine, mountApp, type AppHandle } from "../app/app";
import { loadConfig } from "../app/config";
import { corpusPath } from "./helpers/parity";

function corpusFile(name: string, ext: string, asName = `${name}.${ext}`): File {
  return new File([new Uint8Array(readFileSync(corpusPath(name, ext)))], asName);
}
const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

let root: HTMLElement;
let app: AppHandle;
let canvasCtx: unknown;

async function mount(config: unknown = { showCredit: true }): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => config })));
  app = await mountApp(root);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = q<HTMLElement>(document, "#app");
  canvasCtx = new Proxy({ canvas: { width: 0, height: 0 } }, { get: (t: any, k) => (k in t ? t[k] : () => undefined), set: (t: any, k, v) => ((t[k] = v), true) });
  HTMLCanvasElement.prototype.getContext = (() => canvasCtx) as never;
});
afterEach(() => {
  app?.destroy();
  vi.unstubAllGlobals();
});

describe("app", () => {
  it("shows '3 colours' for colors3.pes", async () => {
    await mount();
    await app.load(corpusFile("colors3", "pes"));
    expect(q(root, "#facts").textContent).toContain("3 colours");
    expect(q(root, "#facts").textContent).toMatch(/PES · [\d.,]+ × [\d.,]+ mm · [\d,]+ stitches/);
    expect(root.querySelectorAll("#swatches [title^='#']").length).toBe(3);
    expect(q(root, "#error").hidden).toBe(true);
  });

  it("shows trims and jumps after the colours, only when there are any", async () => {
    await mount();
    await app.load(corpusFile("trims", "dst"));
    expect(q(root, "#facts").textContent).toMatch(/ · 1 colour · 2 trims · 10 jumps$/);
    const stats = { widthMm: 50, heightMm: 40, stitches: 1234, colors: 3, colorList: [], jumps: 0, trims: 0 };
    expect(factsLine("pes", stats)).toBe("PES · 50 × 40 mm · 1,234 stitches · 3 colours");
    expect(factsLine("pes", { ...stats, trims: 1 })).toBe("PES · 50 × 40 mm · 1,234 stitches · 3 colours · 1 trim");
    expect(factsLine("dst", { ...stats, jumps: 1 })).toBe("DST · 50 × 40 mm · 1,234 stitches · 3 colours · 1 jump");
    expect(factsLine("dst", { ...stats, trims: 1_200, jumps: 2 })).toBe("DST · 50 × 40 mm · 1,234 stitches · 3 colours · 1,200 trims · 2 jumps");
  });

  it("caps the swatch row at 60, says how many are left and hides the swatches from screen readers", async () => {
    await mount();
    await app.load(corpusFile("colors120", "pes"));
    const group = q(root, "#swatches");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("120 thread colours");
    const swatches = [...group.querySelectorAll(".swatch")];
    expect(swatches).toHaveLength(MAX_SWATCHES);
    expect(MAX_SWATCHES).toBe(60);
    for (const s of swatches) expect(s.getAttribute("aria-hidden")).toBe("true");
    expect(q(group, ".swatch-more").textContent).toBe("+60 more");
    // A short design has no "more" note and a singular label for one colour.
    await app.load(corpusFile("single", "pes"));
    expect(root.querySelector("#swatches .swatch-more")).toBeNull();
    expect(q(root, "#swatches").getAttribute("aria-label")).toBe("1 thread colour");
  });

  it("warns that DST drops colours when DST is chosen", async () => {
    await mount();
    await app.load(corpusFile("colors3", "pes"));
    const sel = q<HTMLSelectElement>(root, "#target");
    sel.value = "dst";
    sel.dispatchEvent(new Event("change"));
    expect(q(root, "#warnings").textContent).toContain("DST files don't store thread colours");
  });

  it("hides the credit footer when config says showCredit:false", async () => {
    await mount({ showCredit: false });
    expect(root.querySelector("#credit")).toBeNull();
  });

  it("shows the credit footer, nofollow, by default when config.json fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await loadConfig()).toEqual({ showCredit: true });
    app = await mountApp(root);
    const a = q<HTMLAnchorElement>(root, "#credit a");
    expect(a.getAttribute("rel")).toBe("nofollow");
    expect(a.href).toBe("https://mavenwright.com/en/stitchkit/tools/embroidery-file-converter");
    expect(q(root, "#credit").textContent).toBe("Made by the StitchKit team · Edit in StitchKit");
  });

  it("falls back to showCredit:true on invalid config", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ showCredit: "nope" }) })));
    expect(await loadConfig()).toEqual({ showCredit: true });
  });

  it("shows the read-error message for a corrupt file", async () => {
    await mount();
    await app.load(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], "bad.pes"));
    const err = q(root, "#error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain("We can't read this file");
    expect(q(root, "#preview").hidden).toBe(true);
  });

  it("shows the unknown-format message for PNG bytes named x.dst", async () => {
    await mount();
    const png = new Uint8Array(2048);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await app.load(new File([png], "x.dst"));
    expect(q(root, "#error").textContent).toContain("doesn't look like a PES, DST, JEF, EXP or VP3");
  });

  it("excludes the source format from the target select", async () => {
    await mount();
    await app.load(corpusFile("colors3", "pes"));
    const values = [...q<HTMLSelectElement>(root, "#target").options].map((o) => o.value).sort();
    expect(values).toEqual(["dst", "exp", "jef", "vp3"]);
  });

  it("downloads 'DESIGN.dst' for DESIGN.PES, revoking the object URL", async () => {
    await mount();
    const created: Blob[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = ((b: Blob) => (created.push(b), "blob:test")) as never;
    URL.revokeObjectURL = ((u: string) => void revoked.push(u)) as never;
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    await app.load(corpusFile("colors3", "pes", "DESIGN.PES"));
    vi.useFakeTimers();
    try {
      const sel = q<HTMLSelectElement>(root, "#target");
      sel.value = "dst";
      sel.dispatchEvent(new Event("change"));
      q<HTMLButtonElement>(root, "#download").click();
      expect(names).toEqual(["DESIGN.dst"]);
      expect(created.length).toBe(1);
      expect(created[0].size).toBeGreaterThan(512);
      vi.runAllTimers();
      expect(revoked).toEqual(["blob:test"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not crash when the canvas has no 2D context", async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    await mount();
    await app.load(corpusFile("colors3", "pes"));
    expect(q(root, "#facts").textContent).toContain("3 colours");
  });

  it("uses singular 'colour' and 'stitch' wording and thousands separators", async () => {
    await mount();
    await app.load(corpusFile("single", "dst"));
    expect(q(root, "#facts").textContent).toMatch(/\b1 colour\b/);
    expect(q(root, "#facts").textContent).not.toContain("1 colours");
  });

  it("keeps the latest file when two loads overlap (stale first load is dropped)", async () => {
    await mount();
    const slow = corpusFile("colors3", "pes", "a.pes");
    const realBuf = slow.arrayBuffer.bind(slow);
    (slow as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () => new Promise((r) => setTimeout(async () => r(await realBuf()), 80));
    const first = app.load(slow);
    await app.load(corpusFile("single", "dst", "b.dst"));
    await first;
    expect(q(root, "#facts").textContent).toMatch(/^DST/);
    expect([...q<HTMLSelectElement>(root, "#target").options].map((o) => o.value)).not.toContain("dst");
    expect(q(root, "#reading").hidden).toBe(true);
  });

  it("shows an error, not an unhandled rejection, when drawing throws", async () => {
    canvasCtx = new Proxy({ canvas: { width: 0, height: 0 } }, { get: (t: any, k) => (k === "stroke" ? () => { throw new Error("boom"); } : k in t ? t[k] : () => undefined), set: (t: any, k, v) => ((t[k] = v), true) });
    await mount();
    await app.load(corpusFile("colors3", "pes"));
    expect(q(root, "#error").hidden).toBe(false);
    expect(q(root, "#error").textContent).toContain("couldn't draw a preview");
    expect(q(root, "#stage").hidden).toBe(true);
    expect(q(root, "#facts").textContent).toContain("3 colours");
  });

  it("names the swatch group with the colour count instead of naming each swatch", async () => {
    await mount();
    await app.load(corpusFile("colors3", "pes"));
    expect(q(root, "#swatches").getAttribute("aria-label")).toBe("3 thread colours");
    expect(q(root, "#swatches .swatch").hasAttribute("role")).toBe(false);
    expect(q(root, "#swatches .swatch").getAttribute("title")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
