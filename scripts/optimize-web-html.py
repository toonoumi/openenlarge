#!/usr/bin/env python3
"""Rewrite the landing index pages to use the optimized images.

- Screenshots (hero-shot/step-shot tune|develop|export|library .png) -> <picture>
  with AVIF + WebP sources and a .jpg fallback. Hero is eager + high priority;
  step shots lazy-load. Explicit width/height locks layout (no CLS).
- Gallery/created marquee thumbs -> .webp + loading=lazy.
- Avatars + logo -> .webp.
- i18n.js / releases.js get `defer`.
- Lightbox prefers img.currentSrc (the AVIF/WebP already decoded) over src.
- Preload the hero AVIF in <head>.

Handles both relative ("img/") and absolute ("/img/") path styles. Idempotent
enough for a one-shot run; re-running on already-converted HTML is a no-op for
most rules.
"""
import re
import sys

# 1600px-wide derivative heights (from original aspect ratios)
SHOT_H = {"tune": 1069, "develop": 1077, "export": 1078, "library": 1082}


def convert(html: str) -> str:
    # --- screenshots -> <picture> ---
    shot_re = re.compile(
        r'<img class="(hero-shot|step-shot)" src="(/?img)/(tune|develop|export|library)\.png"([^>]*?)>'
    )

    def shot_sub(m):
        cls, pfx, name, rest = m.groups()
        h = SHOT_H[name]
        if cls == "hero-shot":
            load = ' width="1600" height="%d" fetchpriority="high" decoding="async"' % h
        else:
            load = ' width="1600" height="%d" loading="lazy" decoding="async"' % h
        return (
            '<picture>'
            '<source type="image/avif" srcset="%s/%s.avif">'
            '<source type="image/webp" srcset="%s/%s.webp">'
            '<img class="%s" src="%s/%s.jpg"%s%s>'
            '</picture>'
        ) % (pfx, name, pfx, name, cls, pfx, name, rest, load)

    html = shot_re.sub(shot_sub, html)

    # --- gallery/created marquee thumbs -> webp + lazy ---
    html = re.sub(
        r'<img src="(/?img)/(gallery|created)/([a-z0-9]+)\.jpg"([^>]*?)>',
        r'<img src="\1/\2/\3.webp"\4 loading="lazy" decoding="async">',
        html,
    )

    # --- avatars -> webp (small, kept eager) ---
    html = re.sub(
        r'<img src="(/?img)/av/([a-z0-9]+)\.jpg"',
        r'<img src="\1/av/\2.webp"',
        html,
    )

    # --- logo -> webp ---
    html = re.sub(
        r'(<img class="(?:mark|dl-logo)" src=")(/?img)/app-logo\.jpg(")',
        r'\1\2/app-logo.webp\3',
        html,
    )

    # --- defer the two scripts ---
    html = re.sub(
        r'<script src="([^"]*(?:i18n|releases)\.js)">',
        r'<script defer src="\1">',
        html,
    )

    # --- lightbox: prefer currentSrc (avif/webp already loaded) ---
    html = html.replace(
        'if (t && t.getAttribute("src")) { open(t.getAttribute("src")); }',
        'if (t) { var s = t.currentSrc || t.getAttribute("src"); if (s) open(s); }',
    )

    # --- preload hero avif in <head> (after favicon link) ---
    if "preload" not in html or "tune.avif" not in html:
        html = re.sub(
            r'(<link rel="icon" href="(/?img)/favicon\.png">)',
            r'\1\n<link rel="preload" as="image" href="\2/tune.avif" '
            r'type="image/avif" fetchpriority="high">',
            html,
            count=1,
        )

    return html


def main():
    changed = False
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            src = f.read()
        out = convert(src)
        if out != src:
            with open(path, "w", encoding="utf-8") as f:
                f.write(out)
            print("updated", path)
            changed = True
        else:
            print("no change", path)
    sys.exit(0 if changed else 1)


if __name__ == "__main__":
    main()
