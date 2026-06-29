#!/usr/bin/env bash
# Regenerate the optimized landing/docs images in web/img from the originals
# kept in assets-src/web-img (which is NOT deployed to Cloudflare Pages).
#
# - SCREENSHOTS: downscale to 1600px wide and emit .avif + .webp + a .jpg
#   fallback (consumed via <picture>). Originals are ~2730px PNGs (~2.5MB each).
# - THUMBNAILS (gallery/created/avatars): convert to .webp at source resolution.
# - LOGO: downscale to 256px wide .webp (shown tiny; source is 2048x2048).
#
# Requires: sips (macOS), cwebp, avifenc.  Idempotent: re-running regenerates.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$root/assets-src/web-img"
OUT="$root/web/img"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Quality knobs
AVIF_Q=63   # 0..100, 100=lossless
WEBP_Q=85
JPG_Q=86

shot() {  # $1 = basename; source is $SRC/$1.png -> $OUT/$1.{avif,webp,jpg}
  local b="$1" r="$tmp/$1.png"
  echo "screenshot: $b"
  sips --resampleWidth 1600 "$SRC/$b.png" --out "$r" >/dev/null
  cwebp -quiet -q "$WEBP_Q" "$r" -o "$OUT/$b.webp"
  avifenc -q "$AVIF_Q" -s 6 "$r" "$OUT/$b.avif" >/dev/null
  sips -s format jpeg -s formatOptions "$JPG_Q" "$r" --out "$OUT/$b.jpg" >/dev/null
}

webp() {  # $1 = relative path (no ext); source is $SRC/$1.jpg -> $OUT/$1.webp
  echo "webp: $1"
  cwebp -quiet -q "$WEBP_Q" "$SRC/$1.jpg" -o "$OUT/$1.webp"
}

grid() {  # like webp() but also a small -thumb.webp for the marquee (full opens in lightbox)
  webp "$1"
  sips -Z 700 "$SRC/$1.jpg" --out "$tmp/t.png" >/dev/null   # cap longest edge at 700px
  cwebp -quiet -q 78 "$tmp/t.png" -o "$OUT/$1-thumb.webp"
}

for s in tune develop export library; do shot "$s"; done

for g in gallery/g1 gallery/g2 gallery/g3 gallery/g4 gallery/g5 gallery/g6; do grid "$g"; done
for c in created/c1 created/c2 created/c3 created/c4 created/c5 created/c6 \
         created/c7 created/c8 created/c9 created/c10 created/c11 created/c12; do grid "$c"; done
for a in av/a1 av/a2 av/a3 av/a4 av/a5 av/a6; do webp "$a"; done   # avatars: no thumb (shown 42px)

# Logo: 256px webp from the 2048x2048 source
echo "logo: app-logo"
sips --resampleWidth 256 "$SRC/app-logo.jpg" --out "$tmp/logo.png" >/dev/null
cwebp -quiet -q 90 "$tmp/logo.png" -o "$OUT/app-logo.webp"

# Social share card: 1200x630 (centred crop of the hero screenshot)
echo "og-cover: 1200x630"
sips --resampleWidth 1200 "$SRC/tune.png" --out "$tmp/og.png" >/dev/null
sips -c 630 1200 "$tmp/og.png" --out "$tmp/og-crop.png" >/dev/null
sips -s format jpeg -s formatOptions 85 "$tmp/og-crop.png" --out "$OUT/og-cover.jpg" >/dev/null

echo "done."
