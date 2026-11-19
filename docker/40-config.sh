#!/bin/sh
# Runs from the stock nginx entrypoint (/docker-entrypoint.d/*.sh).
# Writes /usr/share/nginx/html/config.json from SHOW_CREDIT (default true).
#
# This must never fail the container: the image ships a valid default
# config.json ({"showCredit": true}). If the write is impossible (read-only
# root filesystem, read-only bind mount, arbitrary --user / runAsUser), we keep
# the shipped default and exit 0. To make SHOW_CREDIT work on a read-only root
# filesystem, mount a tmpfs or volume over /usr/share/nginx/html (then copy the
# app in) or bind-mount a writable config.json.
dir=/usr/share/nginx/html
raw=$(printf '%s' "${SHOW_CREDIT:-true}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
case "$raw" in
  false|0|no) value=false ;;
  *)          value=true ;;
esac

tmp="$dir/.config.json.$$"
# The braces matter: a failing `> "$tmp"` redirection is reported by the shell itself, so only a group's stderr can
# be silenced. The one message left is the fallback notice below.
if { printf '{"showCredit":%s}' "$value" > "$tmp"; } 2>/dev/null && mv -f "$tmp" "$dir/config.json" 2>/dev/null; then
  :
else
  rm -f "$tmp" 2>/dev/null
  echo "40-config.sh: cannot write config.json, keeping the shipped default" >&2
fi
exit 0
