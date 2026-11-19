// Read parity on the real-world files in corpus/local (gitignored): pystitch reads them all once, in one process,
// then each file is its own fast test. The suite is skipped when there are no files of that format or no pystitch virtualenv.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EmbPattern } from "../../src/core/pattern";
import { HAS_PYTHON, LOCAL_DIR, dumpManyTimeout, localFiles, pythonDumpMany, toRefShape, type RefRead } from "./parity";

export function describeLocalReadParity(label: string, ext: string, read: (bytes: Uint8Array) => EmbPattern): void {
  const files = localFiles(ext);
  describe.skipIf(files.length === 0 || !HAS_PYTHON)(`${label} read parity on corpus/local`, () => {
    let expected = new Map<string, string>();
    beforeAll(() => {
      expected = pythonDumpMany(files);
    }, dumpManyTimeout(files.length));

    it.each(files.map((f): [string, string] => [relative(LOCAL_DIR, f), f]))("%s matches dump.py", (_name, f) => {
      const raw = expected.get(f);
      expect(raw, "dump_many.py returned nothing for this file").toBeDefined();
      const want = JSON.parse(raw!) as RefRead | { error: string };
      const bytes = new Uint8Array(readFileSync(f));
      if ("error" in want) {
        // pystitch raises on it: the reader must refuse it too.
        expect(() => read(bytes)).toThrow();
        return;
      }
      expect(toRefShape(read(bytes))).toEqual(want);
    });
  });
}
