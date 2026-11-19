import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGE, TAG, TOOL_URL, validateDeploy } from "../tools/validate-deploy";

const ROOT = join(__dirname, "..");

describe("deploy/ catalog templates (tools/validate-deploy.ts)", () => {
  it("pass every rule", () => {
    const errors = validateDeploy(ROOT);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  describe("a broken copy is reported", () => {
    const dirs: string[] = [];
    afterEach(() => {
      while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    });
    /** A scratch copy of what the validator reads, with `edit` applied to one file. */
    function broken(file: string, edit: (text: string) => string): string[] {
      const dir = mkdtempSync(join(tmpdir(), "deploy-"));
      dirs.push(dir);
      for (const p of ["deploy", "app", ".gitignore"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
      const path = join(dir, file);
      writeFileSync(path, edit(readFileSync(path, "utf8")));
      return validateDeploy(dir);
    }

    it("an image at the wrong tag", () => {
      const errors = broken("deploy/dokploy/embroidery-converter/docker-compose.yml", (t) => t.replace(`${IMAGE}:${TAG}`, `${IMAGE}:latest`));
      expect(errors.some((e) => e.includes("image"))).toBe(true);
    });
    it("a website field that is not the tool page", () => {
      const errors = broken("deploy/umbrel/umbrel-app.yml", (t) => t.replace(TOOL_URL, "https://example.com/"));
      expect(errors.some((e) => e.includes("website") || e.includes("expected"))).toBe(true);
    });
    it("a repository path that does not exist", () => {
      const errors = broken("deploy/docker-hub-README.md", (t) => `${t}\nhttps://github.com/mavenwright/embroidery-converter/blob/main/nope/missing.md\n`);
      expect(errors.some((e) => e.includes("does not exist"))).toBe(true);
    });
    it("a missing .gitignore entry", () => {
      const errors = broken(".gitignore", (t) => t.replace("corpus/local", ""));
      expect(errors).toContain(".gitignore must list corpus/local");
    });
    it("Easypanel instructions that are an object", () => {
      const errors = broken("deploy/easypanel/meta.yaml", (t) => t.replace(/^instructions:.*$/m, "instructions:\n  a: b"));
      expect(errors.some((e) => e.includes("instructions"))).toBe(true);
    });
  });
});
