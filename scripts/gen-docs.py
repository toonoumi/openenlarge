#!/usr/bin/env python3
"""Regenerate web/docs/** from docs-src/. Run from repo root: python3 scripts/gen-docs.py
Mirrors scripts/gen-i18n.py: docs-src/ is the source of truth; never edit web/docs/ by hand.
"""
import json, pathlib, re, html

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "docs-src"
OUT = ROOT / "web" / "docs"
SITE = "https://openenlarge.io"
BANNER = "<!-- AUTO-GENERATED from /docs-src — do not edit by hand. Run python3 scripts/gen-docs.py -->\n"
LOCALES = ["en", "zh", "ja", "ko"]
HREFLANG = {"en": "en", "zh": "zh-Hans", "ja": "ja", "ko": "ko"}

def load_nav():    return json.loads((SRC / "nav.json").read_text())
def load_strings():return json.loads((SRC / "strings.json").read_text())

def content_file(slug, locale):
    return SRC / "content" / f"{slug.replace('/', '__')}.{locale}.html"

def is_translated(slug, locale):
    """English is canonical; other locales are 'translated' only if a real content file exists."""
    if locale == "en":
        return True
    return content_file(slug, locale).exists()

def body_for(slug, locale):
    src = content_file(slug, locale) if is_translated(slug, locale) else content_file(slug, "en")
    return src.read_text()

def translated_locales(slug):
    """Locales to advertise in hreflang/sitemap for this slug (those with real content)."""
    return [lc for lc in LOCALES if is_translated(slug, lc)]

def renderable(nav):
    """Pages that have config AND an EN content file (other locales fall back to EN)."""
    out = []
    for slug, page in nav["pages"].items():
        if content_file(slug, "en").exists():
            out.append(slug)
    return out

def url_for(slug, locale):
    base = "/docs/" if locale == "en" else f"/docs/{locale}/"
    return base + ("index.html" if slug == "index" else f"{slug}.html")

def out_path(slug, locale):
    sub = "" if locale == "en" else f"{locale}/"
    return OUT / sub / f"{slug}.html"

def depth(slug):  # number of "../" hops from a page back to /docs/<locale>/ root
    return slug.count("/")

def locale_str(strings, locale, key):
    """Return strings[locale][key] falling back to English if locale not present."""
    if locale in strings and key in strings[locale]:
        return strings[locale][key]
    return strings["en"][key]

def page_title(page, locale):
    """Return page title for locale, falling back to English."""
    t = page.get("title", {})
    return t.get(locale, t.get("en", ""))

def page_desc(page, locale):
    """Return page desc for locale, falling back to English."""
    d = page.get("desc", {})
    return d.get(locale, d.get("en", ""))

def sec_title(sec, locale):
    """Return section title for locale, falling back to English."""
    t = sec.get("title", {})
    return t.get(locale, t.get("en", ""))

def sidebar_html(nav, strings, locale, active):
    rset = set(renderable(nav))
    rows = []
    for sec in nav["sections"]:
        pages = [s for s in sec["pages"] if s in rset]
        if not pages: continue
        rows.append(f'<div class="side-sec"><div class="side-h">{html.escape(sec_title(sec, locale))}</div>')
        for slug in pages:
            t = page_title(nav["pages"][slug], locale)
            href = rel_href(active, slug)
            cls = " class=\"on\"" if slug == active else ""
            rows.append(f'<a{cls} href="{href}">{html.escape(t)}</a>')
        rows.append("</div>")
    return "\n".join(rows)

def rel_href(from_slug, to_slug):
    up = "../" * depth(from_slug)
    target = "index.html" if to_slug == "index" else f"{to_slug}.html"
    return up + target

def crumbs_html(nav, strings, locale, slug):
    root = "../" * depth(slug)
    docs_label = locale_str(strings, locale, "docs")
    home = f'<a href="{root}index.html">{html.escape(docs_label)}</a>'
    if slug == "index": return home
    title = html.escape(page_title(nav["pages"][slug], locale))
    return f'{home} <span class="sep">/</span> <span>{title}</span>'

def include_figures(body):
    """Replace <!--FIG:name--> with docs-src/figures/name.svg inline."""
    def sub(m):
        f = SRC / "figures" / f"{m.group(1)}.svg"
        return f.read_text() if f.exists() else m.group(0)
    return re.sub(r"<!--FIG:([a-z0-9\-]+)-->", sub, body)

def seo_blocks(nav, slug, locale):
    page = nav["pages"][slug]
    canon = SITE + url_for(slug, locale)
    alts = []
    for lc in translated_locales(slug):
        alts.append(f'<link rel="alternate" hreflang="{HREFLANG[lc]}" href="{SITE + url_for(slug, lc)}">')
    alts.append(f'<link rel="alternate" hreflang="x-default" href="{SITE + url_for(slug, "en")}">')
    robots = "" if is_translated(slug, locale) else '<meta name="robots" content="noindex,follow">'
    title_str = page_title(page, locale)
    desc_str = page_desc(page, locale)
    og = (f'<meta property="og:type" content="article">'
          f'<meta property="og:title" content="{html.escape(title_str)} — OpenEnlarge Docs">'
          f'<meta property="og:description" content="{html.escape(desc_str)}">'
          f'<meta property="og:url" content="{canon}">')
    # Only advertise an OG image (and the large-image card) once the asset actually
    # exists — otherwise every share renders a broken summary_large_image. The
    # Wave-3 cover drops into docs-src/og/cover.png and lights this up on regen.
    if (SRC / "og" / "cover.png").exists():
        og += (f'<meta property="og:image" content="{SITE}/docs/og/cover.png">'
               f'<meta name="twitter:card" content="summary_large_image">')
    else:
        og += '<meta name="twitter:card" content="summary">'
    jsonld = json.dumps({
        "@context": "https://schema.org", "@type": "TechArticle",
        "headline": title_str, "description": desc_str,
        "inLanguage": HREFLANG[locale], "url": canon,
        "isPartOf": {"@type": "WebSite", "name": "OpenEnlarge", "url": SITE}
    }, ensure_ascii=False)
    return canon, "\n".join(alts), robots, og, f'<script type="application/ld+json">{jsonld}</script>'

def render_page(nav, strings, slug, locale):
    layout = (SRC / "layout.html").read_text()
    page = nav["pages"][slug]
    body = include_figures(body_for(slug, locale))
    canon, alternates, robots, og, jsonld = seo_blocks(nav, slug, locale)
    non_en = 0 if locale == "en" else 1
    docsroot = "../" * (depth(slug) + non_en)
    siteroot = "../" * (depth(slug) + 1 + non_en)
    repl = {
        "HTMLLANG": HREFLANG[locale],
        "TITLE": html.escape(page_title(page, locale)),
        "DESC": html.escape(page_desc(page, locale)),
        "ROOT": "../" * (depth(slug) + 1 + non_en),
        "DOCSROOT": docsroot, "SITEROOT": siteroot,
        "CANONICAL": canon, "ALTERNATES": alternates, "ROBOTS": robots,
        "OG": og, "JSONLD": jsonld,
        "SIDEBAR": sidebar_html(nav, strings, locale, slug),
        "CRUMBS": crumbs_html(nav, strings, locale, slug),
        "BODY": body,
        # TEMPORARY in B1 (replaced by langmenu in B2): keep layout's old lang link valid
        "LANGSWITCHHREF": ("../" * depth(slug)) + ("zh/" if locale == "en" else "../") + ("index.html" if slug == "index" else f"{slug}.html"),
    }
    for k, v in strings.get(locale, strings["en"]).items():
        repl[f"S_{k}"] = html.escape(v)
    html_out = layout
    for k, v in repl.items():
        html_out = html_out.replace("{{" + k + "}}", str(v))
    return BANNER + html_out

def build():
    nav, strings = load_nav(), load_strings()
    pages = renderable(nav)
    for slug in pages:
        for lc in LOCALES:
            p = out_path(slug, lc)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(render_page(nav, strings, slug, lc))
    write_sitemap(nav, pages)
    write_robots()
    copy_assets()
    print(f"wrote {len(pages)*len(LOCALES)} pages to {OUT.relative_to(ROOT)}")

def write_sitemap(nav, pages):
    urls = []
    for slug in pages:
        locs = translated_locales(slug)
        for lc in locs:
            loc = SITE + url_for(slug, lc)
            links = "".join(
                f'<xhtml:link rel="alternate" hreflang="{HREFLANG[l]}" href="{SITE+url_for(slug,l)}"/>'
                for l in locs)
            urls.append(f"<url><loc>{loc}</loc>{links}</url>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
           'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + "\n".join(urls) + "\n</urlset>\n")
    (OUT / "sitemap.xml").write_text(xml)

def write_robots():
    (OUT / "robots.txt").write_text(
        "User-agent: *\nAllow: /\nSitemap: https://openenlarge.io/docs/sitemap.xml\n")

def copy_assets():
    """docs.css and docs.js are authored directly under docs-src/assets and copied verbatim."""
    adir = SRC / "assets"
    for name in ("docs.css", "docs.js"):
        src = adir / name
        if src.exists():
            (OUT / name).write_text(src.read_text())
    # OG share image (binary), if present — Wave 3 drops it at docs-src/og/cover.png.
    cover = SRC / "og" / "cover.png"
    if cover.exists():
        (OUT / "og").mkdir(parents=True, exist_ok=True)
        (OUT / "og" / "cover.png").write_bytes(cover.read_bytes())

if __name__ == "__main__":
    build()
