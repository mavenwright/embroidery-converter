import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string): string => readFileSync(join(__dirname, "..", f), "utf8");
const SEPARATOR = "\n----------------------------------------\n\n";

describe("third-party notices", () => {
  const blocks = read("NOTICE").split(SEPARATOR);
  const readme = read("README.md");

  it("NOTICE holds both licence texts, and the README's NOTICE section repeats them verbatim", () => {
    expect(blocks).toHaveLength(5);
    const [, mit, , psf] = blocks;
    expect(mit).toContain("Copyright (c) 2018");
    expect(psf).toContain("PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2");
    expect(readme).toContain(mit);
    expect(readme).toContain(psf);
  });

  it("keeps the PSF copyright notice and a summary of the changes, as the licence requires", () => {
    expect(blocks[2]).toMatch(/Copyright \(c\) 2001, .*2023 Python Software Foundation; All Rights Reserved/);
    expect(blocks[4]).toMatch(/^Summary of the changes/);
    expect(readme).toContain(blocks[4].trim());
  });

  it("pyset.ts does not claim to come from pystitch", () => {
    expect(read("src/core/pyset.ts").split("\n").slice(0, 3).join("\n")).not.toMatch(/ported from pystitch/i);
  });
});
