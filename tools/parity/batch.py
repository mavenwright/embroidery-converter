#!/usr/bin/env python
"""batch.py dump|write: many pystitch reads or writes in one process (used by compare3.ts).

batch.py dump   stdin: one file path per line.
                stdout: one JSON line per path, {"path", "dump"} or {"path", "error": "<Type>: <msg>"}.
                The dump is dump.py's: a None in pystitch's threadlist (JefReader's unused colour-0 entry) is null.
batch.py write  stdin: one JSON line per job, {"data": <parity JSON>, "out": "<path.ext>"}.
                stdout: one JSON line per job, {"out", "ok": true} or {"out", "error": "<Type>: <msg>"}.
                Writes use write.py's settings (encode, full_jump, trims; fixed date for .jef). A null thread is
                pystitch's None again, so the real writer runs on what the reader produced.
"""
import json
import sys

from dump import dump_file
from write import write_pattern


def _err(e):
    return "%s: %s" % (type(e).__name__, str(e).replace("\n", " "))


def main(mode):
    out = sys.stdout
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        if mode == "dump":
            try:
                rec = {"path": line, "dump": dump_file(line)}
            except Exception as e:  # noqa: BLE001 - any raise is "pystitch could not read it"
                rec = {"path": line, "error": _err(e)}
        else:
            job = json.loads(line)
            try:
                write_pattern(job["data"], job["out"])
                rec = {"out": job["out"], "ok": True}
            except Exception as e:  # noqa: BLE001
                rec = {"out": job["out"], "error": _err(e)}
        out.write(json.dumps(rec, separators=(",", ":")))
        out.write("\n")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("dump", "write"):
        sys.stderr.write(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
