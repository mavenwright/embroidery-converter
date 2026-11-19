# Parity harness

pystitch 1.0.1 is the oracle. The test suite compares the TypeScript output byte for byte with files generated here.

Setup:

    python3.12 -m venv tools/parity/.venv
    tools/parity/.venv/bin/pip install -r tools/parity/requirements.txt

Scripts (all JSON uses the shape `{stitches: [x,y,cmd][], threads: {color:"#rrggbb", description, catalog_number, brand}[], extras: {name?}}`):

- `dump.py <file>` reads any file with pystitch and prints that JSON.
- `write.py <json> <out.ext> [settings-json]` writes with `encode, full_jump, trims` (plus a fixed `date` for `.jef`); the optional JSON object is merged over those. It exits non-zero if the pattern has fewer threads than colour blocks, because pystitch would then use random colours.
- `dump.py --normalized <json> <ext> [settings-json]` prints what pystitch's `write_embroidery` hands to the `<ext>` writer: `get_normalized_pattern(settings)` (the encoder output) for exactly the settings it builds (write.py's defaults, the optional JSON merged over them, then the writer module's constants), plus that `settings` dict. The write is aborted right after normalizing, so the writer never runs.
- `gen_corpus.py [out_dir]` writes `corpus/synthetic/`: per pattern the `.json`, `.dst/.exp/.jef/.pes/.vp3`, `<file>.dump.json` for each, `<name>.v6.pes` (PES version 6) with its dump, and `<name>.<ext>.normalized.json` for the five formats (PES v6 normalizes identically: `version` is not an encoder setting). Output is deterministic.

- A thread is `null` in the JSON where pystitch's threadlist holds `None` (JefReader leaves one for a colour-0 palette entry no colour change uses up). `write.py` turns `null` back into `None`, so pystitch's writers see what its reader produced (and raise on it); `withFillerThreads` in `test/helpers/parity.ts` replaces it with the deterministic filler the TS writers use.
- `dump_many.py -` reads the file paths on stdin and streams one line per file (`<path as JSON>` TAB `<dump or {"error": name}>`); the `corpus/local` read-parity tests use it.
- `batch.py dump|write` does many reads or writes in one process (paths, or JSON jobs, on stdin; one JSON line out per item).
- `npx tsx tools/parity/compare3.ts [--limit N] [--third <dir> [--third-tag <tag>]]` reads every source in `corpus/synthetic` and `corpus/local` with pystitch and the TS port, writes each in all five formats with both (byte comparison), and prints a one-line verdict first. It exits 1 on any TS-vs-pystitch mismatch. `--limit N` takes the first N sources, which are the synthetic ones. With `--third <dir>` it also compares both with another engine's outputs (JSON dumps in the shape above plus the files it wrote, named `<name>.<tag>.json` and `<name>.<tag>.<fmt>`; `--third-tag` sets the tag, default `third`; layout in the script header); without it the third-engine sections are skipped. Report: `corpus/local/compare3-report.md`.

`corpus/local/` is gitignored and holds real-world files.
