# Embroidery File Converter

A browser-only viewer and converter for **PES, DST, JEF, EXP and VP3** machine embroidery files, packaged as a small static web server.

**Files never leave your device.** The container only serves a web page. The conversion runs in your browser, nothing is uploaded, and the server never sees your designs.

- Tool page: https://mavenwright.com/en/stitchkit/tools/embroidery-file-converter
- Source code (MIT): https://github.com/mavenwright/embroidery-converter

Made by MavenWright, the team behind StitchKit, a commercial embroidery app. The converter is free and MIT licensed and does not need StitchKit.

## What it does

- Opens a PES, DST, JEF, EXP or VP3 file, shows a preview and the stitch and colour facts.
- Converts it to any of the other four formats and downloads the result.
- The converter is a TypeScript port of [pystitch](https://github.com/inkstitch/pystitch) 1.0.1, the library Ink/Stitch uses for machine files. The readers and writers are tested against pystitch: on a synthetic test corpus the writers produce the same bytes and the readers return the same stitches for the same input, with documented exceptions (stand-in colours for designs that store none).
- Limits: 1,000,000 stitches or 30 MB per file. Larger files are rejected with a message.
- Always test-stitch a converted file on scrap fabric before production work.

## Quick start

```bash
docker run -d --name embroidery-converter -p 8080:8080 mavenwright/embroidery-converter:1.0.0
```

Then open http://localhost:8080.

With Docker Compose:

```yaml
services:
  embroidery-converter:
    image: mavenwright/embroidery-converter:1.0.0
    ports:
      - "8080:8080"
    environment:
      SHOW_CREDIT: "true"
    restart: unless-stopped
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHOW_CREDIT` | `true` | Shows an optional "Edit in StitchKit" link (with "Made by the StitchKit team") in the page footer, pointing to the converter page on mavenwright.com. Set to `false`, `0` or `no` to hide it. Any other value keeps it on. |

The container listens on port **8080** and runs as the unprivileged `nginx` user (uid 101). There is no database and there are no volumes.

If the filesystem is read-only, or you run it with an arbitrary `--user`, the container cannot rewrite its `config.json`, keeps the shipped default (credit shown) and still starts.

## Images

The image is published for `linux/amd64` and `linux/arm64`.

## Deploy elsewhere

Templates for Dokploy, Unraid, Umbrel, Zeabur and Easypanel are in the [`deploy/` folder of the repository](https://github.com/mavenwright/embroidery-converter/tree/main/deploy).

## License

MIT. The format code is ported from pystitch, which is also MIT; see the NOTICE section of the [README](https://github.com/mavenwright/embroidery-converter#readme).
