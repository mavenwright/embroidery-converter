import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(join(__dirname, "..", "docker", "40-config.sh"), "utf8");
const DEFAULT = '{"showCredit": true}';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

/** Runs docker/40-config.sh with its web root pointed at a scratch directory that holds the shipped default. */
function run(env: Record<string, string>, opts: { readOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.json"), DEFAULT);
  const script = join(dir, "..", `40-config-${process.pid}-${Date.now()}.sh`);
  const patched = SCRIPT.replace("dir=/usr/share/nginx/html", `dir=${JSON.stringify(dir)}`);
  expect(patched).not.toBe(SCRIPT);
  writeFileSync(script, patched);
  if (opts.readOnly) chmodSync(dir, 0o555);
  const r = spawnSync("sh", [script], { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  rmSync(script, { force: true });
  return { ...r, dir, config: readFileSync(join(dir, "config.json"), "utf8"), files: readdirSync(dir) };
}

describe("docker/40-config.sh", () => {
  it("writes showCredit true by default and false for false, 0, no in any case", () => {
    expect(run({}).config).toBe('{"showCredit":true}');
    for (const v of ["false", "FALSE", " False ", "0", "no", "No"]) expect(run({ SHOW_CREDIT: v }).config, v).toBe('{"showCredit":false}');
    expect(run({ SHOW_CREDIT: "banana" }).config).toBe('{"showCredit":true}');
  });

  it("never lets the value reach the shell or the JSON", () => {
    for (const v of ['false"}; touch pwned; echo "', "$(touch pwned)", "`touch pwned`", "x\nfalse"]) {
      const r = run({ SHOW_CREDIT: v });
      expect(r.status, v).toBe(0);
      expect(r.config, v).toMatch(/^\{"showCredit":(true|false)\}$/);
      expect(r.files, v).not.toContain("pwned");
    }
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "on a read-only web root it keeps the shipped default, exits 0 and logs only its own notice",
    () => {
      const r = run({ SHOW_CREDIT: "false" }, { readOnly: true });
      expect(r.status).toBe(0);
      expect(r.config).toBe(DEFAULT);
      expect(r.stderr).not.toMatch(/denied/i);
      expect(r.stderr.trim().split("\n")).toEqual(["40-config.sh: cannot write config.json, keeping the shipped default"]);
      expect(existsSync(join(r.dir, ".config.json"))).toBe(false);
    },
  );
});
