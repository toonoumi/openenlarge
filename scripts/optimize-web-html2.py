#!/usr/bin/env python3
"""Second-pass landing optimizations:

1. Marquee/testimonial photos load a small -thumb.webp; the full-res webp is
   carried in data-full and opened by the lightbox on click.
2. Lightbox prefers data-full (full image) over the displayed thumbnail.
3. Social icons are served from self-hosted /img/icons/*.svg (no external CDN).
4. Open Graph + Twitter Card meta added per page (title/description/url/locale).
"""
import re
import sys
import os

LOCALE = {"": "en_US", "ja": "ja_JP", "ko": "ko_KR", "zh": "zh_CN"}


def lang_of(path: str) -> str:
    d = os.path.dirname(path)
    return d if d in LOCALE else ""


def thumbs_and_icons(html: str) -> str:
    # 1. marquee/qimg photos -> thumb src + data-full (full-res for lightbox)
    html = re.sub(
        r'src="(/?img)/(gallery|created)/([a-z0-9]+)\.webp"',
        r'src="\1/\2/\3-thumb.webp" data-full="\1/\2/\3.webp"',
        html,
    )
    # 2. lightbox prefers data-full
    html = html.replace(
        'var s = t.currentSrc || t.getAttribute("src"); if (s) open(s);',
        'var s = t.getAttribute("data-full") || t.currentSrc || t.getAttribute("src"); if (s) open(s);',
    )
    # 3. self-host social icons
    html = re.sub(
        r'https://cdn\.simpleicons\.org/(github|medium|instagram|reddit|x|discord|xiaohongshu)/9a9aa2',
        r'/img/icons/\1.svg',
        html,
    )
    html = html.replace(
        'https://cdn.simpleicons.org/discord/1a1206', '/img/icons/discord-dark.svg'
    )
    return html


def add_og(html: str, locale: str) -> str:
    if 'property="og:image"' in html:
        return html  # already added
    title_m = re.search(r'<title[^>]*>(.*?)</title>', html, re.S)
    desc_m = re.search(r'<meta name="description" content="([^"]*)"', html)
    canon_m = re.search(r'<link rel="canonical" href="([^"]*)"', html)
    if not (title_m and desc_m and canon_m):
        return html
    title = title_m.group(1).strip()
    desc = desc_m.group(1)
    url = canon_m.group(1)
    img = "https://openenlarge.io/img/og-cover.jpg"
    block = (
        '\n<meta property="og:type" content="website">'
        '\n<meta property="og:site_name" content="OpenEnlarge">'
        f'\n<meta property="og:title" content="{title}">'
        f'\n<meta property="og:description" content="{desc}">'
        f'\n<meta property="og:url" content="{url}">'
        f'\n<meta property="og:locale" content="{locale}">'
        f'\n<meta property="og:image" content="{img}">'
        '\n<meta property="og:image:width" content="1200">'
        '\n<meta property="og:image:height" content="630">'
        '\n<meta name="twitter:card" content="summary_large_image">'
        f'\n<meta name="twitter:image" content="{img}">'
    )
    # insert right after the theme-color meta
    return re.sub(
        r'(<meta name="theme-color"[^>]*>)', r'\1' + block, html, count=1
    )


def main():
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            src = f.read()
        out = thumbs_and_icons(src)
        if os.path.basename(path) == "index.html":
            out = add_og(out, LOCALE[lang_of(path)])
        if out != src:
            with open(path, "w", encoding="utf-8") as f:
                f.write(out)
            print("updated", path)
        else:
            print("no change", path)


if __name__ == "__main__":
    main()
