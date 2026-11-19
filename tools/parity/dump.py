#!/usr/bin/env python
"""dump.py <file>: read a file with pystitch and print the parity JSON shape.

dump.py --normalized <pattern.json> <ext> [settings-json]: print the pattern pystitch's
write_embroidery hands to the <ext> writer, i.e. get_normalized_pattern(settings) for exactly
the settings write_embroidery builds (write.py's defaults, the optional settings JSON merged
over them, then the writer module's constants). The settings dict is included as "settings".
"""
import io
import json
import sys

import pystitch
from pystitch import EmbPattern


def dump_pattern(pattern):
    return {
        "stitches": [[s[0], s[1], s[2]] for s in pattern.stitches],
        # JefReader can leave None in the threadlist (a colour-0 entry no colour change used up): null here.
        "threads": [
            None
            if t is None
            else {
                "color": "#%06x" % (t.color & 0xFFFFFF),
                "description": t.description,
                "catalog_number": t.catalog_number,
                "brand": t.brand,
            }
            for t in pattern.threadlist
        ],
        "extras": {k: v for k, v in pattern.extras.items() if isinstance(v, (str, int, float, bool))},
    }


def dump_file(path):
    pattern = pystitch.read(path)
    if pattern is None:
        raise IOError("pystitch could not read " + path)
    return dump_pattern(pattern)


def writer_for(ext):
    for fmt in pystitch.supported_formats():
        if fmt["extension"] == ext.lower() and fmt.get("writer") is not None:
            return fmt["writer"]
    raise IOError("no pystitch writer for ." + ext)


class _Captured(Exception):
    pass


def normalized_dump(data, ext, extra_settings=None):
    """Runs the real write path into memory and captures the normalized pattern the moment
    get_normalized_pattern returns it. The write is then aborted: the writer never runs (it
    would mutate the pattern, e.g. fix_color_count, and may reject unusual commands)."""
    # Imported here so plain `dump.py <file>` keeps pystitch unpatched; write.py makes the
    # random filler thread fail loudly.
    from write import default_settings, pattern_from_json

    settings = default_settings(ext)
    if extra_settings:
        settings.update(extra_settings)
    captured = []
    original = EmbPattern.get_normalized_pattern

    def capture(self, encode_settings=None):
        result = original(self, encode_settings)
        out = dump_pattern(result)
        out["settings"] = dict(encode_settings)
        captured.append(out)
        raise _Captured()

    EmbPattern.get_normalized_pattern = capture
    try:
        EmbPattern.write_embroidery(writer_for(ext), pattern_from_json(data), io.BytesIO(), settings)
    except _Captured:
        pass
    finally:
        EmbPattern.get_normalized_pattern = original
    if len(captured) != 1:
        raise RuntimeError("write_embroidery did not normalize (is encode off?)")
    return captured[0]


def to_json(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=True)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--normalized":
        if len(sys.argv) not in (4, 5):
            sys.stderr.write(__doc__)
            sys.exit(2)
        with open(sys.argv[2], "r", encoding="utf-8") as f:
            pattern_data = json.load(f)
        extra = json.loads(sys.argv[4]) if len(sys.argv) == 5 else None
        print(to_json(normalized_dump(pattern_data, sys.argv[3], extra)))
        sys.exit(0)
    if len(sys.argv) != 2:
        sys.stderr.write(__doc__)
        sys.exit(2)
    print(to_json(dump_file(sys.argv[1])))
