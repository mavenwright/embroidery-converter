#!/usr/bin/env python
"""dump_many.py <dir>: read every file in <dir> with pystitch (one process) and print
{"<name>": <dump> | {"error": "<ExceptionName>"}} as JSON. Used for corrupt/truncated-input parity.

dump_many.py -: the same for the file paths on stdin (one per line), streamed as one line per file:
<path as JSON string> TAB <dump or error as JSON>. Used for the corpus/local read-parity tests (thousands of files,
so nothing is held in memory)."""
import json
import os
import sys

from dump import dump_file


def dump_or_error(path):
    try:
        return dump_file(path)
    except Exception as e:  # noqa: BLE001 - any raise counts as "pystitch rejects it"
        return {"error": type(e).__name__}


if sys.argv[1] == "-":
    for line in sys.stdin:
        path = line.rstrip("\n")
        if path:
            sys.stdout.write(json.dumps(path) + "\t" + json.dumps(dump_or_error(path)) + "\n")
else:
    out = {name: dump_or_error(os.path.join(sys.argv[1], name)) for name in sorted(os.listdir(sys.argv[1]))}
    print(json.dumps(out))
