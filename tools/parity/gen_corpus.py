#!/usr/bin/env python
"""gen_corpus.py [out_dir]: write the deterministic synthetic parity corpus.

For each pattern: <name>.json, <name>.{dst,exp,jef,pes,vp3} (pystitch-written),
<name>.<ext>.dump.json (pystitch re-read), plus <name>.v6.pes and its dump (PES version 6),
and <name>.<ext>.normalized.json: the encoder output (get_normalized_pattern) that write hands
to each writer, with the settings it used. PES version 6 is not repeated there: "version" is
not an encoder setting, so its normalized pattern equals <name>.pes.normalized.json.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dump import dump_file, normalized_dump, to_json  # noqa: E402
from write import write_pattern  # noqa: E402

STITCH, JUMP, TRIM, COLOR_CHANGE = 0, 1, 2, 5
EXTS = ["dst", "exp", "jef", "pes", "vp3"]
DEFAULT_COLORS = ["#d62828", "#1d70b8", "#2a9d3f", "#f4b400", "#7b2cbf", "#00a6a6"]


def thread(color, i):
    return {"color": color, "description": "Thread %d" % (i + 1), "catalog_number": str(100 + i), "brand": "Parity"}


def pat(name, stitches, colors):
    changes = sum(1 for s in stitches if s[2] == COLOR_CHANGE)
    if len(colors) < changes + 1:
        raise SystemExit("pattern %s: %d threads for %d colour blocks" % (name, len(colors), changes + 1))
    return {
        "stitches": stitches,
        "threads": [thread(c, i) for i, c in enumerate(colors)],
        "extras": {"name": name},
    }


def line(x0, y0, x1, y1, step):
    """Stitches (absolute) from (x0,y0) to (x1,y1) with segments of about `step` units."""
    n = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) // step))
    return [[x0 + (x1 - x0) * i // n, y0 + (y1 - y0) * i // n, STITCH] for i in range(1, n + 1)]


def p_lines():
    s = [[0, 0, STITCH]]
    s += line(0, 0, 30, 0, 30)  # short
    s += line(30, 0, 30, 400, 400)  # long (needs splitting)
    s += line(30, 400, -250, 500, 280)
    s += [[-250, 500, JUMP], [200, -350, JUMP]]
    s += line(200, -350, 700, 100, 500)
    s += [[0, 0, JUMP], [3, 4, STITCH], [-5, 9, STITCH]]
    return pat("lines", s, DEFAULT_COLORS[:1])


def p_fill():
    s = [[0, 0, STITCH]]
    rows, cols = 70, 70  # 70x70 serpentine grid, 3 units pitch
    for r in range(rows):
        xs = range(cols) if r % 2 == 0 else range(cols - 1, -1, -1)
        for c in xs:
            s.append([c * 3, r * 3, STITCH])
    return pat("fill", s, DEFAULT_COLORS[:1])


def p_colors3():
    s = [[0, 0, STITCH]]
    for b in range(3):
        s += [[100 * b + 50, y, STITCH] for y in range(0, 200, 20)]
        s += [[100 * b + 90, 200, STITCH], [100 * b + 10, 10, STITCH]]
        if b < 2:
            s.append([100 * b + 10, 10, COLOR_CHANGE])
    return pat("colors3", s, DEFAULT_COLORS[:3])


def p_trims():
    s = [[0, 0, STITCH]]
    s += line(0, 0, 200, 0, 40)
    s += [[200, 0, TRIM], [400, 300, JUMP]]
    s += line(400, 300, 400, 600, 40)
    s += [[400, 600, TRIM], [-100, 600, JUMP]]
    s += line(-100, 600, 100, 800, 40)
    return pat("trims", s, DEFAULT_COLORS[:1])


def p_bigjump():
    s = [[0, 0, STITCH]]
    s += line(0, 0, 100, 0, 25)
    s += [[3100, 0, JUMP]]  # 300 mm jump
    s += [[3100, 0, STITCH]] + line(3100, 0, 3100, 100, 25)
    return pat("bigjump", s, DEFAULT_COLORS[:1])


def p_colors120():
    s = [[0, 0, STITCH]]
    colors = []
    for i in range(120):
        r = (i * 67 + 13) % 256
        g = (i * 131 + 71) % 256
        b = (i * 29 + 200) % 256
        colors.append("#%02x%02x%02x" % (r, g, b))
        x = (i % 12) * 60
        y = (i // 12) * 60
        s += [[x, y, STITCH], [x + 40, y + 15, STITCH], [x + 20, y + 40, STITCH]]
        if i < 119:
            s.append([x + 20, y + 40, COLOR_CHANGE])
    return pat("colors120", s, colors)


def p_single():
    return pat("single", [[10, 20, STITCH]], DEFAULT_COLORS[:1])


def p_large():
    s = [[0, 0, STITCH]]
    s += line(0, 0, 4000, 0, 100)
    s += line(4000, 0, 4000, 4000, 100)
    s += line(4000, 4000, 0, 4000, 100)
    s += line(0, 4000, 0, 0, 100)
    s += line(0, 0, 4000, 4000, 100)
    return pat("large", s, DEFAULT_COLORS[:1])


def p_negative():
    s = [[-10, -10, STITCH]]
    s += line(-10, -10, -400, -10, 40)
    s += line(-400, -10, -400, -300, 40)
    s += [[-400, -300, JUMP], [-50, -500, JUMP], [-50, -500, STITCH]]
    s += line(-50, -500, -250, -120, 40)
    return pat("negative", s, DEFAULT_COLORS[:1])


PATTERNS = [p_lines, p_fill, p_colors3, p_trims, p_bigjump, p_colors120, p_single, p_large, p_negative]


def main(argv):
    out = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "corpus", "synthetic")
    os.makedirs(out, exist_ok=True)
    for make in PATTERNS:
        data = make()
        name = data["extras"]["name"]
        json_path = os.path.join(out, name + ".json")
        with open(json_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(to_json(data) + "\n")
        jobs = [(ext, None, name + "." + ext) for ext in EXTS] + [("pes", {"version": 6}, name + ".v6.pes")]
        for ext, extra, fname in jobs:
            path = os.path.join(out, fname)
            write_pattern(data, path, extra)
            with open(path + ".dump.json", "w", encoding="utf-8", newline="\n") as f:
                f.write(to_json(dump_file(path)) + "\n")
        for ext in EXTS:
            with open(os.path.join(out, name + "." + ext + ".normalized.json"), "w", encoding="utf-8", newline="\n") as f:
                f.write(to_json(normalized_dump(data, ext)) + "\n")
        print("ok", name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
