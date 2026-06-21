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
LOCALES = ["en", "zh"]

def load_nav():    return json.loads((SRC / "nav.json").read_text())
def load_strings():return json.loads((SRC / "strings.json").read_text())

def content_file(slug, locale):
    return SRC / "content" / f"{slug.replace('/', '__')}.{locale}.html"

def renderable(nav):
    """Pages that have config AND an EN+ZH content file."""
    out = []
    for slug, page in nav["pages"].items():
        if all(content_file(slug, lc).exists() for lc in LOCALES):
            out.append(slug)
    return out

def url_for(slug, locale):
    base = "/docs/" if locale == "en" else "/docs/zh/"
    return base + ("" if slug == "index" else f"{slug}.html") + ("index.html" if slug == "index" else "")

def out_path(slug, locale):
    sub = "" if locale == "en" else "zh/"
    return OUT / sub / (f"{slug}.html")

def depth(slug):  # number of "../" hops from a page back to /docs/<locale>/ root
    return slug.count("/")

def sidebar_html(nav, strings, locale, active):
    rset = set(renderable(nav))
    rows = []
    for sec in nav["sections"]:
        pages = [s for s in sec["pages"] if s in rset]
        if not pages: continue
        rows.append(f'<div class="side-sec"><div class="side-h">{html.escape(sec["title"][locale])}</div>')
        for slug in pages:
            t = nav["pages"][slug]["title"][locale]
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
    home = f'<a href="{root}index.html">{html.escape(strings[locale]["docs"])}</a>'
    if slug == "index": return home
    title = html.escape(nav["pages"][slug]["title"][locale])
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
    for lc in LOCALES:
        hl = "en" if lc == "en" else "zh-Hans"
        alts.append(f'<link rel="alternate" hreflang="{hl}" href="{SITE + url_for(slug, lc)}">')
    alts.append(f'<link rel="alternate" hreflang="x-default" href="{SITE + url_for(slug, "en")}">')
    og = (f'<meta property="og:type" content="article">'
          f'<meta property="og:title" content="{html.escape(page["title"][locale])} — OpenEnlarge Docs">'
          f'<meta property="og:description" content="{html.escape(page["desc"][locale])}">'
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
        "headline": page["title"][locale], "description": page["desc"][locale],
        "inLanguage": "en" if locale == "en" else "zh-Hans", "url": canon,
        "isPartOf": {"@type": "WebSite", "name": "OpenEnlarge", "url": SITE}
    }, ensure_ascii=False)
    return canon, "\n".join(alts), og, f'<script type="application/ld+json">{jsonld}</script>'

def render_page(nav, strings, slug, locale):
    layout = (SRC / "layout.html").read_text()
    page = nav["pages"][slug]
    body = include_figures(content_file(slug, locale).read_text())
    canon, alternates, og, jsonld = seo_blocks(nav, slug, locale)
    root = "../" * depth(slug)               # back to /docs/<locale>/
    docsroot = "../" * (depth(slug) + (0 if locale == "en" else 1))  # docs.css/js live ONLY at web/docs/ (one extra ../ for zh)
    siteroot = "../" * (depth(slug) + (1 if locale == "en" else 2))  # back to /  (… /docs/ or /docs/zh/)
    # locale swap: replace leading ../ chain target with other-locale root
    langswitchhref = (("../" * depth(slug)) + ("zh/" if locale == "en" else "../")) + ("index.html" if slug=="index" else f"{slug}.html")
    repl = {
        "HTMLLANG": "en" if locale == "en" else "zh-Hans",
        "TITLE": html.escape(page["title"][locale]),
        "DESC": html.escape(page["desc"][locale]),
        "ROOT": "../" * (depth(slug) + (1 if locale=="en" else 2)) + "",  # to /web root for img/
        "DOCSROOT": docsroot, "SITEROOT": siteroot,
        "CANONICAL": canon, "ALTERNATES": alternates, "OG": og, "JSONLD": jsonld,
        "SIDEBAR": sidebar_html(nav, strings, locale, slug),
        "CRUMBS": crumbs_html(nav, strings, locale, slug),
        "BODY": body, "LANGSWITCHHREF": langswitchhref,
    }
    for k, v in strings[locale].items():
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
    print(f"wrote {len(pages)*2} pages to {OUT.relative_to(ROOT)}")

def write_sitemap(nav, pages):
    urls = []
    for slug in pages:
        for lc in LOCALES:
            loc = SITE + url_for(slug, lc)
            links = "".join(
                f'<xhtml:link rel="alternate" hreflang="{"en" if l=="en" else "zh-Hans"}" href="{SITE+url_for(slug,l)}"/>'
                for l in LOCALES)
            urls.append(f"<url><loc>{loc}</loc>{links}</url>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
           'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + "\n".join(urls) + "\n</urlset>\n")
    (OUT / "sitemap.xml").parent.mkdir(parents=True, exist_ok=True)
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
