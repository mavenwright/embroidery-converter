#!/usr/bin/env python
"""write.py <pattern.json> <out.ext> [settings-json]

Writes a pattern (the parity JSON shape) with pystitch, using the settings that mirror
Ink/Stitch's export: encode, full_jump, trims (plus a fixed date for .jef). An optional third
argument (a JSON object string) is merged over those defaults.

pystitch fills missing threads with RANDOM colours, which would make the output
nondeterministic. This script refuses to write such a pattern (non-zero exit).
"""
import json
import os
import sys

import pystitch
from pystitch import EmbPattern, EmbThread


class RandomFillerError(RuntimeError):
    pass


def _no_random_thread():
    raise RandomFillerError(
        "pattern has fewer threads than colour blocks: pystitch would use a RANDOM filler colour"
    )


# Fail loudly instead of letting pystitch pick random.getrandbits(24) colours.
EmbPattern.get_random_thread = staticmethod(_no_random_thread)


def pattern_from_json(data):
    pattern = EmbPattern()
    for x, y, cmd in data["stitches"]:
        pattern.add_stitch_absolute(cmd, x, y)
    for t in data["threads"]:
        if t is None:
            # dump.py's null: put pystitch's None back, so the writer sees what JefReader produced.
            pattern.threadlist.append(None)
            continue
        thread = EmbThread()
        thread.set(t["color"])
        thread.description = t.get("description")
        thread.catalog_number = t.get("catalog_number")
        thread.brand = t.get("brand")
        pattern.add_thread(thread)
    for k, v in (data.get("extras") or {}).items():
        pattern.extras[k] = v
    return pattern


def default_settings(ext):
    settings = {"encode": True, "full_jump": True, "trims": True}
    if ext.lower() == "jef":
        settings["date"] = "20260101000000"
    return settings


def write_pattern(data, out_path, extra_settings=None):
    ext = os.path.splitext(out_path)[1].lstrip(".")
    settings = default_settings(ext)
    if extra_settings:
        settings.update(extra_settings)
    # Encode beside the target, then rename into place only on success.
    tmp_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), ".tmp-%d.%s" % (os.getpid(), ext))
    try:
        pystitch.write(pattern_from_json(data), tmp_path, settings)
        os.replace(tmp_path, out_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def main(argv):
    if len(argv) not in (3, 4):
        sys.stderr.write(__doc__)
        return 2
    with open(argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
    extra = json.loads(argv[3]) if len(argv) == 4 else None
    write_pattern(data, argv[2], extra)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
