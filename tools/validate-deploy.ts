// Validates the catalog templates in deploy/ (Dokploy, Unraid, Umbrel, Zeabur, Easypanel) and a few repository
// invariants. Nothing here talks to the network.
//
// Rules:
//  - every YAML / TOML / JSON / XML / SVG file under deploy/ parses;
//  - every website / Project / WebPage / homepage field, and every "Website" link entry, is the tool page URL;
//  - every "Github" link entry is the repository URL, and every repository tree/blob/raw path exists;
//  - no TODO / TBD / FIXME / PLACEHOLDER anywhere, except the one digest token in the Umbrel compose file;
//  - every image reference is mavenwright/embroidery-converter:1.0.0, with the digest token on Umbrel only;
//  - the catalog shapes: Dokploy, Umbrel, Zeabur and Easypanel (instructions is a string or null), ports 8080;
//  - app/app.ts's CREDIT_URL is the tool page URL, and .gitignore keeps build output, local corpora and the
//    Python virtualenv out of the repository.
//
// Run it with `npm run validate:deploy`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export const TOOL_URL = "https://mavenwright.com/en/stitchkit/tools/embroidery-file-converter";
export const REPO_URL = "https://github.com/mavenwright/embroidery-converter";
export const IMAGE = "mavenwright/embroidery-converter";
export const TAG = "1.0.0";
/** The only placeholder allowed in the kit: the multi-arch manifest digest, known only after the image is pushed. */
export const DIGEST_TOKEN = "DIGEST_PLACEHOLDER";
/** Files that may carry the digest token: Umbrel needs it. */
export const DEPLOY = "deploy";
export const DIGEST_FILES = [`${DEPLOY}/umbrel/docker-compose.yml`];
/** Every mavenwright.com URL in the kit must be one of these. */
export const ALLOWED_MAVENWRIGHT_URLS = [TOOL_URL];
/** Every github.com/mavenwright URL must start with one of these (the org page itself is allowed exactly). */
export const ALLOWED_GITHUB_PREFIXES = [REPO_URL, "https://github.com/mavenwright/unraid-templates"];
export const ALLOWED_RAW_PREFIXES = [
  "https://raw.githubusercontent.com/mavenwright/embroidery-converter/main/",
  "https://raw.githubusercontent.com/mavenwright/unraid-templates/main/",
];
const TEXT_EXT = /\.(md|ya?ml|toml|json|xml|svg|ts)$/i;

export const REQUIRED_FILES = [
  `${DEPLOY}/logo.svg`,
  `${DEPLOY}/logo.png`,
  `${DEPLOY}/docker-hub-README.md`,
  `${DEPLOY}/dokploy/embroidery-converter/docker-compose.yml`,
  `${DEPLOY}/dokploy/embroidery-converter/template.toml`,
  `${DEPLOY}/dokploy/embroidery-converter/meta.json`,
  `${DEPLOY}/dokploy/embroidery-converter/logo.svg`,
  `${DEPLOY}/unraid/embroidery-converter.xml`,
  `${DEPLOY}/unraid/ca_profile.xml`,
  `${DEPLOY}/umbrel/umbrel-app.yml`,
  `${DEPLOY}/umbrel/docker-compose.yml`,
  `${DEPLOY}/zeabur/template.yaml`,
  `${DEPLOY}/easypanel/meta.yaml`,
  `${DEPLOY}/easypanel/index.ts`,
];

/** What a caller can add on top of the deploy/ checks (the same file rules apply to the extra directories). */
export interface ValidateOptions {
  /** More directories, relative to the root, whose files get the same parse, URL, image and placeholder checks. */
  extraDirs?: string[];
  /** More files, relative to the root, that may carry the digest token. */
  extraDigestFiles?: string[];
  /** Rewrites a file's text before the placeholder scan (for tokens a caller allows in particular files). */
  scanText?: (relPath: string, text: string) => string;
}

const URL_KEYS = new Set(["website", "homepage", "Project", "WebPage"]);
const BANNED = /\b(TODO|TBD|FIXME|PLACEHOLDER|CHANGEME)\b/;

export function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function parseFile(path: string, text: string): unknown {
  const lower = path.toLowerCase();
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return parseYaml(text);
  if (lower.endsWith(".toml")) return parseToml(text);
  if (lower.endsWith(".json")) return JSON.parse(text);
  if (lower.endsWith(".xml") || lower.endsWith(".svg")) {
    const ok = XMLValidator.validate(text);
    if (ok !== true) throw new Error(`invalid XML: ${ok.err.msg} (line ${ok.err.line})`);
    return new XMLParser({ ignoreAttributes: false }).parse(text);
  }
  return undefined;
}

/** Calls fn for every object node in a parsed tree. */
function eachObject(node: unknown, fn: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => eachObject(n, fn));
  else if (node && typeof node === "object") {
    fn(node as Record<string, unknown>);
    Object.values(node as Record<string, unknown>).forEach((n) => eachObject(n, fn));
  }
}

function eachImage(node: unknown, fn: (image: string) => void): void {
  eachObject(node, (o) => {
    if (typeof o.image === "string") fn(o.image);
    const src = o.source;
    if (src && typeof src === "object" && typeof (src as Record<string, unknown>).image === "string") {
      fn((src as Record<string, unknown>).image as string);
    }
  });
}

export function validateDeploy(root: string, options: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  if (!existsSync(join(root, DEPLOY))) return [`${DEPLOY}/ does not exist`];
  const extraDirs = (options.extraDirs ?? []).filter((d) => existsSync(join(root, d)));
  const digestFiles = [...DIGEST_FILES, ...(options.extraDigestFiles ?? [])];

  for (const f of REQUIRED_FILES) if (!existsSync(join(root, f))) errors.push(`missing required file: ${f}`);

  const files = [DEPLOY, ...extraDirs].flatMap((d) => walkFiles(join(root, d)));
  const rel = (p: string) => relative(root, p).split(sep).join("/");
  const parsed = new Map<string, unknown>();
  let websiteFields = 0;

  for (const path of files) {
    const r = rel(path);
    if (!TEXT_EXT.test(r)) continue;
    const text = readFileSync(path, "utf8");

    // Unfinished-work words and the digest token.
    let scan = options.scanText ? options.scanText(r, text) : text;
    if (digestFiles.includes(r)) scan = scan.split(DIGEST_TOKEN).join("");
    const hit = BANNED.exec(scan);
    if (hit) errors.push(`${r}: contains "${hit[0]}"`);
    if (!digestFiles.includes(r) && text.includes(DIGEST_TOKEN)) errors.push(`${r}: digest token is not allowed in this file`);

    // Image references in free text (compose files, READMEs, copy, XML).
    const re = new RegExp(`(?<![\\w./-])${IMAGE.replace(/[/-]/g, "\\$&")}(?<rest>[^\\s"'\`<)]*)`, "g");
    for (const m of text.matchAll(re)) {
      const rest = (m.groups?.rest ?? "").replace(/[.,;:]+$/, "");
      const okPlain = rest === `:${TAG}`;
      const okDigest = rest === `:${TAG}@sha256:${DIGEST_TOKEN}` || new RegExp(`^:${TAG.replace(/\./g, "\\.")}@sha256:[0-9a-f]{64}$`).test(rest);
      if (!okPlain && !(okDigest && r === `${DEPLOY}/umbrel/docker-compose.yml`)) {
        errors.push(`${r}: image reference "${IMAGE}${rest}" must be ${IMAGE}:${TAG}${r === `${DEPLOY}/umbrel/docker-compose.yml` ? `@sha256:${DIGEST_TOKEN}` : ""}`);
      }
    }

    // Text-wide URL pass: every project URL anywhere in any file (descriptions and readmes included).
    const trim = (u: string) => u.replace(/[.,;:!?]+$/, "");
    for (const m of text.matchAll(/https?:\/\/(?:www\.)?mavenwright\.com[^\s"'<>)\]`]*/g)) {
      const u = trim(m[0]);
      if (!ALLOWED_MAVENWRIGHT_URLS.includes(u)) errors.push(`${r}: mavenwright.com URL "${u}" is not in the allowed set`);
    }
    for (const m of text.matchAll(/https:\/\/github\.com\/mavenwright[^\s"'<>)\]`]*/g)) {
      const u = trim(m[0]);
      if (u !== "https://github.com/mavenwright" && !ALLOWED_GITHUB_PREFIXES.some((pre) => u === pre || u.startsWith(`${pre}/`) || u.startsWith(`${pre}.`) || u.startsWith(`${pre}#`))) {
        errors.push(`${r}: github URL "${u}" is not the repo, the unraid-templates repo or the org page`);
      }
    }
    for (const m of text.matchAll(/https:\/\/github\.com\/mavenwright\/embroidery-converter\/(?:tree|blob)\/main\/([^\s"'<>)\]`#?]*)/g)) {
      const path = trim(m[1]);
      if (path !== "" && !existsSync(join(root, path))) errors.push(`${r}: github URL "${trim(m[0])}" points at a path that does not exist in this repo`);
    }
    for (const m of text.matchAll(/https:\/\/raw\.githubusercontent\.com\/mavenwright[^\s"'<>)\]`]*/g)) {
      const u = trim(m[0]);
      const pre = ALLOWED_RAW_PREFIXES.find((x) => u.startsWith(x));
      if (!pre) errors.push(`${r}: raw URL "${u}" is not an allowed raw prefix`);
      else if (pre.includes("/embroidery-converter/") && !existsSync(join(root, u.slice(pre.length)))) errors.push(`${r}: raw URL "${u}" points at a file that does not exist in this repo`);
    }

    // Structured parse.
    let tree: unknown;
    try {
      tree = parseFile(r, text);
    } catch (e) {
      errors.push(`${r}: does not parse: ${(e as Error).message}`);
      continue;
    }
    if (tree === undefined) continue;
    parsed.set(r, tree);

    eachObject(tree, (o) => {
      for (const [k, v] of Object.entries(o)) {
        if (URL_KEYS.has(k) && typeof v === "string") {
          websiteFields++;
          if (v !== TOOL_URL) errors.push(`${r}: ${k} is "${v}", expected ${TOOL_URL}`);
        }
      }
      // Easypanel style: links: [{label, url}] and the Dokploy-style links object.
      if (typeof o.label === "string" && typeof o.url === "string") {
        const label = o.label.toLowerCase();
        if (label === "website") {
          websiteFields++;
          if (o.url !== TOOL_URL) errors.push(`${r}: Website link is "${o.url}", expected ${TOOL_URL}`);
        } else if (label === "github" && o.url !== REPO_URL) {
          errors.push(`${r}: Github link is "${o.url}", expected ${REPO_URL}`);
        }
      }
      if (o.links && typeof o.links === "object" && !Array.isArray(o.links)) {
        const l = o.links as Record<string, unknown>;
        if (typeof l.github === "string" && l.github !== REPO_URL) errors.push(`${r}: links.github is "${l.github}", expected ${REPO_URL}`);
      }
    });

    // Every compose-style image must be ours at the agreed tag.
    eachImage(tree, (img) => {
      if (!img.startsWith(`${IMAGE}:${TAG}`)) errors.push(`${r}: image "${img}" is not ${IMAGE}:${TAG}`);
    });
  }

  // Catalog-specific shape checks (only when the files parsed).
  const dpl = parsed.get(`${DEPLOY}/dokploy/embroidery-converter/docker-compose.yml`) as any;
  const dplMeta = parsed.get(`${DEPLOY}/dokploy/embroidery-converter/meta.json`) as any;
  const dplToml = parsed.get(`${DEPLOY}/dokploy/embroidery-converter/template.toml`) as any;
  if (dpl) {
    const svc = dpl.services?.["embroidery-converter"];
    if (!svc) errors.push("dokploy compose: service must be named embroidery-converter (the folder name)");
    else {
      if (svc.ports) errors.push("dokploy compose: must not publish ports (use expose)");
      if (svc.container_name) errors.push("dokploy compose: must not set container_name");
      if (svc.networks) errors.push("dokploy compose: must not set networks");
      if (svc.image !== `${IMAGE}:${TAG}`) errors.push(`dokploy compose: image must be ${IMAGE}:${TAG}`);
    }
    if (dpl.version) errors.push("dokploy compose: top-level version is rejected by the Dokploy validator");
  }
  if (dplMeta) {
    if (dplMeta.id !== "embroidery-converter") errors.push("dokploy meta.json: id must equal the folder name");
    if (dplMeta.version !== TAG) errors.push(`dokploy meta.json: version must equal the image tag ${TAG}`);
    if (dplMeta.logo !== "logo.svg") errors.push("dokploy meta.json: logo must be logo.svg");
    if (!dplMeta.links?.website) errors.push("dokploy meta.json: links.website missing");
    else websiteFields++;
    for (const k of ["github", "website", "docs"]) if (typeof dplMeta.links?.[k] !== "string") errors.push(`dokploy meta.json: links.${k} missing`);
    if (!Array.isArray(dplMeta.tags) || dplMeta.tags.length === 0) errors.push("dokploy meta.json: tags must be a non-empty array");
  }
  if (dplToml) {
    const d = dplToml.config?.domains?.[0];
    if (!d || d.serviceName !== "embroidery-converter" || d.port !== 8080) errors.push("dokploy template.toml: one domain for embroidery-converter on port 8080 is required");
  }
  const umb = parsed.get(`${DEPLOY}/umbrel/docker-compose.yml`) as any;
  if (umb) {
    const img = umb.services?.app?.image;
    const digestOk = typeof img === "string" && (img === `${IMAGE}:${TAG}@sha256:${DIGEST_TOKEN}` || new RegExp(`^${IMAGE}:${TAG.replace(/\./g, "\\.")}@sha256:[0-9a-f]{64}$`).test(img));
    if (!digestOk) errors.push(`umbrel compose: services.app.image must be ${IMAGE}:${TAG}@sha256:<digest> (the token ${DIGEST_TOKEN} until the image is pushed)`);
    const p = umb.services?.app_proxy?.environment;
    if (!p || p.APP_HOST !== "embroidery-converter_app_1" || Number(p.APP_PORT) !== 8080) errors.push("umbrel compose: app_proxy needs APP_HOST embroidery-converter_app_1 and APP_PORT 8080");
  }
  const umbApp = parsed.get(`${DEPLOY}/umbrel/umbrel-app.yml`) as any;
  if (umbApp) {
    if (umbApp.id !== "embroidery-converter") errors.push("umbrel-app.yml: id must be embroidery-converter");
    if (umbApp.repo !== REPO_URL) errors.push(`umbrel-app.yml: repo must be ${REPO_URL}`);
  }
  const zea = parsed.get(`${DEPLOY}/zeabur/template.yaml`) as any;
  if (zea) {
    if (zea.apiVersion !== "zeabur.com/v1" || zea.kind !== "Template") errors.push("zeabur: apiVersion/kind must be zeabur.com/v1 / Template");
    for (const s of zea.spec?.services ?? []) {
      if (s.spec?.source?.image !== `${IMAGE}:${TAG}`) errors.push(`zeabur: service image must be ${IMAGE}:${TAG}`);
      if (!(s.spec?.ports ?? []).some((p: any) => p.port === 8080 && p.type === "HTTP")) errors.push("zeabur: needs an HTTP port 8080");
    }
  }

  // Easypanel instructions: a plain string or null (their docs build escapes it as text).
  const epMeta = parsed.get(`${DEPLOY}/easypanel/meta.yaml`) as any;
  if (epMeta && !(epMeta.instructions === null || typeof epMeta.instructions === "string")) errors.push("easypanel meta.yaml: instructions must be a string or null, not an object");

  // Credit link and ports.
  const appTs = join(root, "app", "app.ts");
  if (!existsSync(appTs)) errors.push("app/app.ts not found");
  else {
    const m = /CREDIT_URL\s*=\s*"([^"]+)"/.exec(readFileSync(appTs, "utf8"));
    if (!m || m[1] !== TOOL_URL) errors.push(`app/app.ts: CREDIT_URL is "${m?.[1]}", expected ${TOOL_URL}`);
  }
  const unraidPath = join(root, DEPLOY, "unraid", "embroidery-converter.xml");
  if (existsSync(unraidPath)) {
    const x = readFileSync(unraidPath, "utf8");
    if (!/<Config [^>]*Type="Port"[^>]*>8080<\/Config>/.test(x) || !/Target="8080"/.test(x)) errors.push("unraid: the Port config must be target 8080, default 8080");
    if (!/<WebUI>[^<]*\[PORT:8080\][^<]*<\/WebUI>/.test(x)) errors.push("unraid: WebUI must use [PORT:8080]");
  }
  const epPath = join(root, DEPLOY, "easypanel", "index.ts");
  if (existsSync(epPath)) {
    const ports = [...readFileSync(epPath, "utf8").matchAll(/\bport:\s*(\d+)/g)].map((m) => Number(m[1]));
    if (ports.length === 0 || ports.some((n) => n !== 8080)) errors.push(`easypanel index.ts: every port must be 8080, found ${ports.join(",") || "none"}`);
  }
  const gi = join(root, ".gitignore");
  const ignored = existsSync(gi) ? readFileSync(gi, "utf8").split("\n").map((l) => l.trim().replace(/\/$/, "")) : [];
  for (const entry of ["node_modules", "dist", "corpus/local", "tools/parity/.venv", ".DS_Store"]) {
    if (!ignored.includes(entry)) errors.push(`.gitignore must list ${entry}`);
  }

  // Each catalog that has a website field must have one.
  if (websiteFields < 5) errors.push(`expected at least 5 website/Project/WebPage fields across the catalog templates, found ${websiteFields}`);
  return errors;
}

// `npm run validate:deploy` runs this file directly (needs Node 22.6+ or tsx); `npm test` runs it through test/deploy.test.ts.
if (process.argv[1]?.endsWith("validate-deploy.ts")) {
  const errors = validateDeploy(process.cwd());
  if (errors.length) {
    console.error(errors.map((e) => `FAIL ${e}`).join("\n"));
    process.exit(1);
  }
  console.log("deploy/ OK (parse, URLs, images, ports, catalog shapes)");
}
