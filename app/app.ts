import {
  EmbroideryReadError,
  EmbroideryWriteError,
  READ_MESSAGES,
  WRITE_MESSAGES,
  computeStats,
  conversionWarnings,
  convert,
  detectFormat,
  readEmbroidery,
  renderPattern,
  type EmbPattern,
  type Format,
  type PatternStats,
  type RenderContext,
} from "../src/index";
import { loadConfig } from "./config";

const ALL_FORMATS: readonly Format[] = ["pes", "dst", "jef", "exp", "vp3"];
const CREDIT_URL = "https://mavenwright.com/en/stitchkit/tools/embroidery-file-converter";
const PAPER = "#fbfaf6";
/** A DST can hold thousands of colour changes: show a bounded row and say how many are left. */
export const MAX_SWATCHES = 60;

const TEMPLATE = `
<main class="wrap">
  <header>
    <h1>Free Embroidery File Converter</h1>
    <p class="lede">View and convert PES, DST, JEF, EXP and VP3. Files never leave your device.</p>
  </header>

  <label class="drop" id="drop">
    <input id="file" type="file" accept=".pes,.dst,.jef,.exp,.vp3" />
    <span class="drop-title">Drop an embroidery file</span>
    <span class="drop-sub">or <span class="link">choose a file</span></span>
  </label>

  <p id="reading" class="reading" role="status" hidden>Reading\u2026</p>
  <p id="error" class="error" role="alert" hidden></p>

  <section id="preview" class="preview" aria-label="Preview" hidden>
    <div class="stage" id="stage">
      <canvas id="canvas" role="img" aria-label="Preview of the embroidery design"></canvas>
      <p id="busy" class="busy" hidden>Rendering…</p>
    </div>
    <div class="side">
      <p id="facts" class="facts"></p>
      <div id="swatches" class="swatches" role="group" aria-label="Thread colours"></div>
      <div class="convert">
        <label for="target">Convert to</label>
        <select id="target"></select>
        <button id="download" type="button">Download</button>
      </div>
      <ul id="warnings" class="warnings" role="status"></ul>
    </div>
  </section>

  <div class="notes">
    <p>Your files never leave your device. Everything is read, previewed and converted in this browser tab.</p>
    <p>Always test-stitch a converted design on scrap fabric before you use it in production.</p>
  </div>
</main>
<footer class="foot" id="foot"></footer>
`;

export interface AppHandle {
  /** Reads, previews and offers a conversion of the file. Resolves when the UI has settled. */
  load(file: File): Promise<void>;
  /** Removes the listeners the app added to the document and window. */
  destroy(): void;
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const mm = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** "DST · 50 × 40 mm · 1,234 stitches · 3 colours", then "· 2 trims" and "· 5 jumps" only when the design has any. */
export function factsLine(format: Format, s: PatternStats): string {
  const parts = [format.toUpperCase(), `${mm(s.widthMm)} × ${mm(s.heightMm)} mm`, plural(s.stitches, "stitch", "stitches"), plural(s.colors, "colour", "colours")];
  if (s.trims > 0) parts.push(plural(s.trims, "trim", "trims"));
  if (s.jumps > 0) parts.push(plural(s.jumps, "jump", "jumps"));
  return parts.join(" · ");
}

/** Resolves on the next paint, or after 50 ms in a background tab where frames don't fire. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 50);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        clearTimeout(t);
        resolve();
      });
    }
  });
}

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function readMessage(e: unknown): string {
  return e instanceof EmbroideryReadError ? e.message : READ_MESSAGES.corrupt;
}

function writeMessage(e: unknown): string {
  if (e instanceof EmbroideryWriteError) return e.message;
  if (e instanceof EmbroideryReadError) return e.message;
  return WRITE_MESSAGES.write_failed;
}

export async function mountApp(root: HTMLElement): Promise<AppHandle> {
  root.innerHTML = TEMPLATE;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`) as T;
  const drop = $("drop");
  const input = $<HTMLInputElement>("file");
  const errorEl = $("error");
  const readingEl = $("reading");
  const previewEl = $("preview");
  const stage = $("stage");
  const canvas = $<HTMLCanvasElement>("canvas");
  const busy = $("busy");
  const facts = $("facts");
  const swatches = $("swatches");
  const target = $<HTMLSelectElement>("target");
  const downloadBtn = $<HTMLButtonElement>("download");
  const warningsEl = $("warnings");

  let bytes: Uint8Array | null = null;
  let filename = "";
  let source: Format | null = null;
  let pattern: EmbPattern | null = null;
  let renderToken = 0;
  let loadToken = 0;
  let lastW = 0;
  let lastH = 0;

  const showError = (msg: string): void => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  };
  const clearError = (): void => {
    errorEl.textContent = "";
    errorEl.hidden = true;
  };

  async function render(): Promise<void> {
    if (!pattern) return;
    const token = ++renderToken;
    const ctx = canvas.getContext("2d") as unknown as RenderContext | null;
    if (!ctx) return;
    // Show the state and let it paint first: a big design draws in one synchronous pass.
    busy.hidden = false;
    stage.setAttribute("aria-busy", "true");
    await nextFrame();
    if (token !== renderToken || !pattern) return;
    const width = stage.clientWidth || 320;
    const height = stage.clientHeight || 240;
    try {
      renderPattern(pattern, ctx, { width, height, background: PAPER, dpr: window.devicePixelRatio || 1 });
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      lastW = width;
      lastH = height;
    } catch {
      stage.hidden = true;
      showError("We couldn't draw a preview of this design, but you can still convert it.");
    } finally {
      busy.hidden = true;
      stage.removeAttribute("aria-busy");
    }
  }

  function updateWarnings(): void {
    warningsEl.replaceChildren();
    if (!pattern) return;
    for (const w of conversionWarnings(pattern, target.value as Format)) {
      const li = document.createElement("li");
      li.textContent = w.message;
      warningsEl.append(li);
    }
  }

  function fillTargets(from: Format): void {
    target.replaceChildren();
    for (const f of ALL_FORMATS) {
      if (f === from) continue;
      const o = document.createElement("option");
      o.value = f;
      o.textContent = f.toUpperCase();
      target.append(o);
    }
    target.value = from === "dst" ? "pes" : "dst";
    if (target.value === from) target.selectedIndex = 0;
  }

  function reset(): void {
    pattern = null;
    bytes = null;
    source = null;
    renderToken++;
    lastW = 0;
    lastH = 0;
    stage.hidden = false;
    previewEl.hidden = true;
    warningsEl.replaceChildren();
  }

  async function load(file: File): Promise<void> {
    const token = ++loadToken;
    clearError();
    reset();
    readingEl.hidden = false;
    try {
      const data = await readBytes(file);
      if (token !== loadToken) return;
      const format = detectFormat(data, file.name);
      await nextFrame();
      if (token !== loadToken) return;
      const p = readEmbroidery(data, file.name);
      bytes = data;
      filename = file.name;
      source = format;
      pattern = p;
    } catch (e) {
      if (token !== loadToken) return;
      readingEl.hidden = true;
      showError(readMessage(e));
      return;
    }
    readingEl.hidden = true;
    const stats = computeStats(pattern as EmbPattern);
    facts.textContent = factsLine((source ?? "pes") as Format, stats);
    swatches.replaceChildren();
    // The group's label carries the count; the individual swatches are decoration.
    swatches.setAttribute("aria-label", plural(stats.colorList.length, "thread colour", "thread colours"));
    for (const hex of stats.colorList.slice(0, MAX_SWATCHES)) {
      const s = document.createElement("span");
      s.className = "swatch";
      s.style.backgroundColor = hex;
      s.title = hex;
      s.setAttribute("aria-hidden", "true");
      swatches.append(s);
    }
    if (stats.colorList.length > MAX_SWATCHES) {
      const more = document.createElement("span");
      more.className = "swatch-more";
      more.textContent = `+${(stats.colorList.length - MAX_SWATCHES).toLocaleString("en-US")} more`;
      swatches.append(more);
    }
    fillTargets(source as Format);
    updateWarnings();
    previewEl.hidden = false;
    await render();
  }

  function download(): void {
    if (!bytes || !source) return;
    clearError();
    let out: { bytes: Uint8Array; outName: string };
    try {
      out = convert(bytes, filename, target.value as Format);
    } catch (e) {
      showError(writeMessage(e));
      return;
    }
    const url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    if ("download" in a) {
      a.href = url;
      a.download = out.outName;
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } else {
      // Old iOS Safari ignores the download attribute: show the file in a new tab instead.
      if (!window.open(url, "_blank")) showError("Your browser blocked the download. Allow pop-ups for this page and try again.");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) void load(f);
    input.value = "";
  });
  target.addEventListener("change", updateWarnings);
  downloadBtn.addEventListener("click", download);

  drop.addEventListener("dragenter", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) void load(f);
  });
  // A file dropped beside the zone must not navigate the tab away.
  const stray = (e: Event): void => e.preventDefault();
  for (const ev of ["dragover", "drop"]) document.addEventListener(ev, stray);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Unhiding the preview fires the observer too: skip it when the size is what was last drawn.
      if (stage.clientWidth === lastW && stage.clientHeight === lastH) return;
      void render();
    }, 150);
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  if (observer) observer.observe(stage);
  else window.addEventListener("resize", onResize);
  const destroy = (): void => {
    clearTimeout(timer);
    observer?.disconnect();
    window.removeEventListener("resize", onResize);
    for (const ev of ["dragover", "drop"]) document.removeEventListener(ev, stray);
    loadToken++;
    renderToken++;
  };

  const config = await loadConfig();
  if (config.showCredit) {
    const p = document.createElement("p");
    p.id = "credit";
    p.append("Made by the StitchKit team · ");
    const a = document.createElement("a");
    a.href = CREDIT_URL;
    a.rel = "nofollow";
    a.textContent = "Edit in StitchKit";
    p.append(a);
    $("foot").append(p);
  }

  return { load, destroy };
}
