# Japanese & Korean Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Japanese (`ja`) and Korean (`ko`) to the desktop app UI, the documentation site, and the marketing landing/blog pages — with SEO-correct per-locale URLs and `hreflang`.

**Architecture:** Each surface keeps its existing source-of-truth → generator → committed-output model. The app extends a CSV→`dict.ts` generator; the docs extend a Python static generator (with English-body fallback for untranslated pages); the landing/blog moves from client-side text-swapping on one URL to a new Python generator emitting per-locale static pages. All generated output is committed (Cloudflare Pages does a direct upload of `web/` with no build step).

**Tech Stack:** Python 3 (stdlib `csv`/`json`/`unittest`), Svelte + TypeScript (app), vanilla JS (landing runtime), static HTML.

## Global Constraints

- **Locale set, in this order:** `en`, `zh`, `ja`, `ko`. Display labels: `English`, `中文`, `日本語`, `한국어`.
- **hreflang codes:** `en → en`, `zh → zh-Hans`, `ja → ja`, `ko → ko`. `x-default → en`.
- **Never hand-edit generated output.** `app/src/lib/i18n/dict.ts`, everything under `web/docs/`, and the new per-locale landing pages are generated. Edit the source, regenerate, commit both.
- **Generated output is committed.** CI deploy is a direct upload — generators run locally/in the task, not at deploy time.
- **English is canonical** and lives at the un-prefixed path (`/index.html`, `/docs/index.html`). Other locales live under a single-segment prefix (`/zh/`, `/ja/`, `/ko/`, `/docs/zh/`, …).
- **EN body fallback for docs:** a locale page whose body is the English fallback (no real translation file) is emitted `noindex` and excluded from `hreflang`/sitemap until a real `{slug}.{locale}.html` exists.
- **Python tests use stdlib `unittest`** (pytest is not installed). Run with `python3 -m unittest scripts/test_*.py -v`. Run all generators/tests from the repo root.
- **Translation terminology must stay consistent** across surfaces. Use this glossary for both `ja` and `ko`:
  - film base = ja「ベース濃度／フィルムベース」 ko「필름 베이스」
  - density = ja「濃度」 ko「농도」
  - invert/inversion = ja「反転」 ko「반전」
  - develop = ja「現像」 ko「현상」
  - tone = ja「トーン」 ko「톤」
  - contact sheet = ja「コンタクトシート」 ko「콘택트 시트」
  - roll = ja「ロール」 ko「롤」
  - Keep the product name **OpenEnlarge** untranslated everywhere.

---

# Phase A — Desktop app (Svelte)

Source of truth: `i18n-strings.csv` → `python3 scripts/gen-i18n.py` → `app/src/lib/i18n/dict.ts`.

## Task A1: Make `gen-i18n.py` locale-agnostic (derive locales from CSV header)

Today the generator hardcodes `en`/`zh`. Make it emit every language column found in the CSV, so adding `ja`/`ko` (and any future locale) needs no script edit.

**Files:**
- Modify: `scripts/gen-i18n.py`
- Test: `scripts/test_gen_i18n.py` (create)

**Interfaces:**
- Produces: regenerated `app/src/lib/i18n/dict.ts` with one top-level key per language column in the CSV (all columns except the metadata columns `key`, `file`, `note`), preserving CSV column order.

- [ ] **Step 1: Write the failing test**

Create `scripts/test_gen_i18n.py`:

```python
import sys, pathlib, importlib.util, unittest
ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("gen_i18n", ROOT / "scripts" / "gen-i18n.py")
gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)

class TestLocaleColumns(unittest.TestCase):
    def test_locales_excludes_metadata(self):
        header = ["key", "en", "zh", "ja", "ko", "file", "note"]
        self.assertEqual(gen.locale_columns(header), ["en", "zh", "ja", "ko"])

    def test_locales_two_column_legacy(self):
        header = ["key", "en", "zh", "file", "note"]
        self.assertEqual(gen.locale_columns(header), ["en", "zh"])

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest scripts/test_gen_i18n.py -v`
Expected: FAIL — `AttributeError: module 'gen_i18n' has no attribute 'locale_columns'`.

- [ ] **Step 3: Implement the minimal change**

Replace the body of `scripts/gen-i18n.py` `main()` and add a helper. The full new file:

```python
#!/usr/bin/env python3
"""Regenerate app/src/lib/i18n/dict.ts from i18n-strings.csv.

The CSV is the source of truth for UI strings. Its header is
`key,<locale>,<locale>,...,file,note`; every column that is not `key`, `file`,
or `note` is treated as a locale. Run from the repo root:  python3 scripts/gen-i18n.py
"""
import csv, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV = ROOT / "i18n-strings.csv"
OUT = ROOT / "app/src/lib/i18n/dict.ts"
META_COLUMNS = {"key", "file", "note"}


def locale_columns(header):
    return [c for c in header if c not in META_COLUMNS]


def emit(d):
    return "\n".join(
        f"    {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)},"
        for k, v in d.items()
    )


def main():
    reader = csv.DictReader(CSV.open(newline=""))
    rows = list(reader)
    locales = locale_columns(reader.fieldnames)
    dicts = {lc: {r["key"]: r[lc] for r in rows} for lc in locales}
    body = "".join(f"  {lc}: {{\n{emit(dicts[lc])}\n  }},\n" for lc in locales)
    OUT.write_text(
        "// AUTO-GENERATED from /i18n-strings.csv — do not edit by hand.\n"
        "// To change strings, edit the CSV and regenerate (see scripts/gen-i18n.py).\n"
        "export const dict: Record<string, Record<string, string>> = {\n"
        f"{body}"
        "};\n"
    )
    print(f"wrote {OUT.relative_to(ROOT)} with {len(rows)} keys × {len(locales)} locales")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest scripts/test_gen_i18n.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Regenerate and confirm no diff yet**

Run: `python3 scripts/gen-i18n.py && cd app && npx svelte-check --tsconfig ./tsconfig.json; cd ..`
Expected: prints `wrote app/src/lib/i18n/dict.ts with <N> keys × 2 locales`; `git diff --stat app/src/lib/i18n/dict.ts` shows no meaningful change (still only `en`/`zh` — the CSV hasn't gained columns yet). svelte-check passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-i18n.py scripts/test_gen_i18n.py
git commit -m "refactor(i18n): derive app locales from CSV header columns"
```

## Task A2: Add `ja`/`ko` columns + translations to the CSV; widen the app's Locale type

**Files:**
- Modify: `i18n-strings.csv` (add `ja`,`ko` columns after `zh`; translate all rows)
- Modify: `app/src/lib/i18n/index.ts` (Locale type + LOCALES)
- Modify: `app/src/lib/catalog.ts` (pref validation)
- Modify (generated): `app/src/lib/i18n/dict.ts` (via regen)

**Interfaces:**
- Consumes: `locale_columns()` from Task A1 (the generator auto-emits the new columns).
- Produces: `Locale = "en" | "zh" | "ja" | "ko"`; `LOCALES` includes `ja`/`ko`.

- [ ] **Step 1: Add the two columns to the CSV header and every row**

The header line must change from `key,en,zh,file,note` to `key,en,zh,ja,ko,file,note`. Every data row gains a `ja` value and a `ko` value inserted in the same column positions (between the `zh` value and the `file` value). Use a script to insert empty columns first, then fill translations, to avoid hand-misaligning 479 rows:

```python
# scripts/_add_locale_columns.py  (one-shot helper; delete after use)
import csv, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
p = ROOT / "i18n-strings.csv"
rows = list(csv.DictReader(p.open(newline="")))
fieldnames = ["key", "en", "zh", "ja", "ko", "file", "note"]
with p.open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    for r in rows:
        r.setdefault("ja", ""); r.setdefault("ko", "")
        w.writerow({k: r.get(k, "") for k in fieldnames})
print("added ja/ko columns")
```

Run: `python3 scripts/_add_locale_columns.py && rm scripts/_add_locale_columns.py`
Expected: header is now `key,en,zh,ja,ko,file,note`; `ja`/`ko` cells are empty.

- [ ] **Step 2: Translate every row's `ja` and `ko` cells**

Fill the `ja` and `ko` cell of every row, translating from the `en` value (use `zh` as a cross-check). Rules:
- Follow the **terminology glossary** in Global Constraints exactly.
- Keep `OpenEnlarge` and any interpolation placeholders (e.g. `{count}`, `{name}`) verbatim.
- Match punctuation conventions of the target language (Japanese 「」 and 。; Korean uses Western punctuation).
- Where `en` is a UI label/button, prefer concise native equivalents over literal translation.
- Edit the CSV directly (a spreadsheet or careful text edit). Do **not** leave any `ja`/`ko` cell empty — an empty cell renders as an empty string, not an English fallback, in the app.

Verify no empty cells:

```bash
python3 - <<'PY'
import csv, pathlib
rows = list(csv.DictReader(open("i18n-strings.csv", newline="")))
missing = [r["key"] for r in rows if not r["ja"].strip() or not r["ko"].strip()]
print("rows missing ja/ko:", len(missing))
assert not missing, missing[:20]
PY
```
Expected: `rows missing ja/ko: 0`.

- [ ] **Step 3: Regenerate the dict**

Run: `python3 scripts/gen-i18n.py`
Expected: `wrote app/src/lib/i18n/dict.ts with <N> keys × 4 locales`. `git diff app/src/lib/i18n/dict.ts` shows new `ja:` and `ko:` blocks.

- [ ] **Step 4: Widen the Locale type and LOCALES list**

In `app/src/lib/i18n/index.ts`:

```typescript
export type Locale = "en" | "zh" | "ja" | "ko";

export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
];
```

- [ ] **Step 5: Make the pref validation membership-based**

In `app/src/lib/catalog.ts`, replace the hardcoded `||` chain (around line 69) that checks `snap.prefs.locale === "en" || snap.prefs.locale === "zh"`. Import `LOCALES` (if not already imported alongside `locale`) and validate against it:

```typescript
if (LOCALES.some((l) => l.id === snap.prefs.locale))
  locale.set(snap.prefs.locale as Locale);
```

Confirm the import line at the top of `catalog.ts` includes `LOCALES` and `Locale` from `./i18n` (extend the existing `import { locale } from "./i18n"` to `import { locale, LOCALES, type Locale } from "./i18n"`).

- [ ] **Step 6: Typecheck**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json; cd ..`
Expected: 0 errors. (The `Locale` widening flows through; `dict.ts` is `Record<string,...>` so it already accepts the new keys.)

- [ ] **Step 7: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts app/src/lib/i18n/index.ts app/src/lib/catalog.ts
git commit -m "feat(i18n): add Japanese & Korean app UI locales"
```

- [ ] **Step 8: Manual smoke test (record result)**

Run the app (`cd app && npm run tauri dev`), open the settings menu. Expected: four language buttons (English / 中文 / 日本語 / 한국어). Click 日本語 then 한국어 — UI text switches; restart the app and confirm the last choice persisted.

---

# Phase B — Documentation site

Source of truth: `docs-src/` → `python3 scripts/gen-docs.py` → `web/docs/`. Existing tests: `scripts/test_gen_docs.py`.

## Task B1: Generalize the docs generator to N locales with EN-body fallback + noindex

**Files:**
- Modify: `scripts/gen-docs.py`
- Test: `scripts/test_gen_docs.py` (extend)

**Interfaces:**
- Produces:
  - `LOCALES = ["en", "zh", "ja", "ko"]`
  - `HREFLANG = {"en": "en", "zh": "zh-Hans", "ja": "ja", "ko": "ko"}`
  - `is_translated(slug, locale) -> bool` — True if a real `{slug}.{locale}.html` content file exists (English is always True).
  - `body_for(slug, locale) -> str` — returns the locale body if translated, else the English body.
  - `renderable(nav)` now requires only the **English** content file to exist.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test_gen_docs.py` (new test class):

```python
class TestMultiLocale(unittest.TestCase):
    def setUp(self): gen.build()

    def test_four_locale_dirs(self):
        for lc in ("zh", "ja", "ko"):
            self.assertTrue((ROOT / f"web/docs/{lc}/index.html").exists(), f"{lc} index missing")

    def test_hreflang_map(self):
        self.assertEqual(gen.HREFLANG["ja"], "ja")
        self.assertEqual(gen.HREFLANG["ko"], "ko")

    def test_untranslated_page_is_noindex(self):
        # index has no ja translation yet -> EN fallback body -> noindex, no ja in its own hreflang set
        html = (ROOT / "web/docs/ja/index.html").read_text()
        self.assertIn('name="robots" content="noindex', html)

    def test_untranslated_excluded_from_hreflang(self):
        # the EN page should NOT advertise an alternate for an untranslated ja page
        en = (ROOT / "web/docs/index.html").read_text()
        # ja alternate only appears once a real index.ja.html exists; assert it's absent now
        self.assertNotIn('hreflang="ja"', en)

    def test_html_lang_attribute(self):
        ja = (ROOT / "web/docs/ja/index.html").read_text()
        self.assertIn('<html lang="ja">', ja)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest scripts/test_gen_docs.py -v`
Expected: FAIL — `ja`/`ko` dirs don't exist; `gen.HREFLANG` missing.

- [ ] **Step 3: Implement the generalization**

Edit `scripts/gen-docs.py`:

(a) Replace the locale list and add the hreflang map near the top:

```python
LOCALES = ["en", "zh", "ja", "ko"]
HREFLANG = {"en": "en", "zh": "zh-Hans", "ja": "ja", "ko": "ko"}
```

(b) Add translation helpers (after `content_file`):

```python
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
```

(c) `renderable()` — require only the English content file:

```python
def renderable(nav):
    """Pages that have config AND an EN content file (other locales fall back to EN)."""
    out = []
    for slug, page in nav["pages"].items():
        if content_file(slug, "en").exists():
            out.append(slug)
    return out
```

(d) `url_for()` and `out_path()` — prefix for any non-en locale:

```python
def url_for(slug, locale):
    base = "/docs/" if locale == "en" else f"/docs/{locale}/"
    return base + ("index.html" if slug == "index" else f"{slug}.html")

def out_path(slug, locale):
    sub = "" if locale == "en" else f"{locale}/"
    return OUT / sub / f"{slug}.html"
```

(e) `seo_blocks()` — advertise only translated locales, and emit `noindex` for fallback pages. Change the signature to accept whether this page is a fallback, and build alternates from `translated_locales(slug)`:

```python
def seo_blocks(nav, slug, locale):
    page = nav["pages"][slug]
    canon = SITE + url_for(slug, locale)
    alts = []
    for lc in translated_locales(slug):
        alts.append(f'<link rel="alternate" hreflang="{HREFLANG[lc]}" href="{SITE + url_for(slug, lc)}">')
    alts.append(f'<link rel="alternate" hreflang="x-default" href="{SITE + url_for(slug, "en")}">')
    robots = "" if is_translated(slug, locale) else '<meta name="robots" content="noindex,follow">'
    og = (f'<meta property="og:type" content="article">'
          f'<meta property="og:title" content="{html.escape(page["title"][locale])} — OpenEnlarge Docs">'
          f'<meta property="og:description" content="{html.escape(page["desc"][locale])}">'
          f'<meta property="og:url" content="{canon}">')
    if (SRC / "og" / "cover.png").exists():
        og += (f'<meta property="og:image" content="{SITE}/docs/og/cover.png">'
               f'<meta name="twitter:card" content="summary_large_image">')
    else:
        og += '<meta name="twitter:card" content="summary">'
    jsonld = json.dumps({
        "@context": "https://schema.org", "@type": "TechArticle",
        "headline": page["title"][locale], "description": page["desc"][locale],
        "inLanguage": HREFLANG[locale], "url": canon,
        "isPartOf": {"@type": "WebSite", "name": "OpenEnlarge", "url": SITE}
    }, ensure_ascii=False)
    return canon, "\n".join(alts), robots, og, f'<script type="application/ld+json">{jsonld}</script>'
```

(f) `render_page()` — consume `body_for`, the new `robots` return value, `HREFLANG`, and generalized depth math. Replace the relevant lines:

```python
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
        "TITLE": html.escape(page["title"][locale]),
        "DESC": html.escape(page["desc"][locale]),
        "ROOT": "../" * (depth(slug) + 1 + non_en),
        "DOCSROOT": docsroot, "SITEROOT": siteroot,
        "CANONICAL": canon, "ALTERNATES": alternates, "ROBOTS": robots,
        "OG": og, "JSONLD": jsonld,
        "SIDEBAR": sidebar_html(nav, strings, locale, slug),
        "CRUMBS": crumbs_html(nav, strings, locale, slug),
        "BODY": body,
        "LANGMENU": langmenu_html(nav, strings, slug, locale),
    }
    for k, v in strings[locale].items():
        repl[f"S_{k}"] = html.escape(v)
    html_out = layout
    for k, v in repl.items():
        html_out = html_out.replace("{{" + k + "}}", str(v))
    return BANNER + html_out
```

> Note: `LANGMENU`/`langmenu_html` and the `{{ROBOTS}}` placeholder are added in Task B2 — for THIS task, temporarily set `"LANGMENU": ""` and add `"ROBOTS": robots` only after you add the placeholder to `layout.html`. To keep B1 self-contained, add `{{ROBOTS}}` to `layout.html` now (Step 4 below) and leave the old `{{LANGSWITCHHREF}}`/`{{S_langSwitch}}` link in place until B2; set `"LANGSWITCHHREF"` using the existing binary logic generalized to "next locale" is unnecessary — instead, for B1, keep the old two values working by mapping any non-en locale's switch target to English and en's to zh (placeholder, replaced in B2):

```python
    # TEMPORARY in B1 (replaced by langmenu in B2): keep layout's old lang link valid
    repl["LANGSWITCHHREF"] = ("../" * depth(slug)) + ("zh/" if locale == "en" else "../") + ("index.html" if slug == "index" else f"{slug}.html")
```

(g) `write_sitemap()` — iterate `translated_locales(slug)` for both the `<url>` entries and their alternates, so untranslated fallback pages are omitted:

```python
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
```

(h) `build()` — print count generalized:

```python
    print(f"wrote {len(pages)*len(LOCALES)} pages to {OUT.relative_to(ROOT)}")
```

- [ ] **Step 4: Add the `{{ROBOTS}}` placeholder to the layout**

In `docs-src/layout.html`, add the robots line in `<head>` right after the `<meta name="description">` line (line 7):

```html
<meta name="description" content="{{DESC}}">
{{ROBOTS}}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m unittest scripts/test_gen_docs.py -v`
Expected: PASS, including the new `TestMultiLocale` class and all pre-existing tests (canonical/hreflang tests still pass — `zh` is untranslated-or-translated depending on existing files; if existing `.zh.html` files exist they stay in hreflang). If a pre-existing test asserts `hreflang="zh-Hans"` on the EN index, it still holds because `.zh.html` files already exist for those pages.

- [ ] **Step 6: Regenerate and eyeball output**

Run: `python3 scripts/gen-docs.py`
Expected: `wrote <N> pages …`. Open `web/docs/ja/index.html`: `<html lang="ja">`, localized nav (after B3 chrome translation it's localized; for now nav strings may show `ja` keys missing — that's fixed in B3), English body, `noindex` meta present.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-docs.py scripts/test_gen_docs.py docs-src/layout.html web/docs
git commit -m "feat(docs): N-locale generator with EN-body fallback + noindex for untranslated pages"
```

## Task B2: 4-locale language menu in the docs layout

Replace the binary language link with a menu listing all four locales.

**Files:**
- Modify: `docs-src/layout.html`
- Modify: `scripts/gen-docs.py` (add `langmenu_html`)
- Modify: `docs-src/assets/docs.css` (menu styling)
- Test: `scripts/test_gen_docs.py` (extend)

**Interfaces:**
- Consumes: `LOCALES`, `url_for`, `depth` (Task B1).
- Produces: `langmenu_html(nav, strings, slug, locale) -> str` returning a `<details class="langmenu">` disclosure whose links point to each locale's URL for `slug`, current locale marked `aria-current`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test_gen_docs.py`:

```python
class TestLangMenu(unittest.TestCase):
    def setUp(self): gen.build()
    def test_menu_lists_all_locales(self):
        html = (ROOT / "web/docs/index.html").read_text()
        for label in ("English", "中文", "日本語", "한국어"):
            self.assertIn(label, html)
    def test_menu_links_relative(self):
        # from EN root index, the ja link is ja/index.html
        html = (ROOT / "web/docs/index.html").read_text()
        self.assertIn('href="ja/index.html"', html)
    def test_current_locale_marked(self):
        html = (ROOT / "web/docs/ja/index.html").read_text()
        self.assertIn('aria-current="true"', html)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest scripts/test_gen_docs.py -v`
Expected: FAIL — labels/links absent (`langmenu_html` not implemented; layout still uses old link).

- [ ] **Step 3: Implement `langmenu_html`**

Add to `scripts/gen-docs.py` (near `crumbs_html`). Labels are fixed UI text, independent of page language:

```python
LOCALE_LABELS = {"en": "English", "zh": "中文", "ja": "日本語", "ko": "한국어"}

def lang_href(from_slug, from_locale, to_locale):
    """Relative href from the current page to the same slug in another locale."""
    up = "../" * depth(from_slug)          # back to /docs/<from_locale>/ root
    if from_locale != "en":
        up += "../"                         # up out of the locale subdir to /docs/
    if to_locale != "en":
        up += f"{to_locale}/"
    return up + ("index.html" if from_slug == "index" else f"{from_slug}.html")

def langmenu_html(nav, strings, slug, locale):
    items = []
    for lc in LOCALES:
        cur = ' aria-current="true"' if lc == locale else ""
        href = lang_href(slug, locale, lc)
        items.append(f'<a{cur} href="{href}">{LOCALE_LABELS[lc]}</a>')
    label = LOCALE_LABELS[locale]
    return ('<details class="langmenu"><summary>' + label + '</summary>'
            '<div class="langmenu-list">' + "".join(items) + '</div></details>')
```

- [ ] **Step 4: Wire it into `render_page`**

In `render_page`, the `repl` dict already references `"LANGMENU": langmenu_html(nav, strings, slug, locale)` (from B1 Step 3f). Remove the temporary `repl["LANGSWITCHHREF"]` line added in B1.

- [ ] **Step 5: Update the layout**

In `docs-src/layout.html`, replace the lang link line (line 24):

```html
    <a class="lang-link" href="{{LANGSWITCHHREF}}">{{S_langSwitch}}</a>
```

with:

```html
    {{LANGMENU}}
```

The `langSwitch` string in `strings.json` is now unused by the layout but harmless; leave it.

- [ ] **Step 6: Add menu styling**

Append to `docs-src/assets/docs.css`:

```css
.langmenu{position:relative;font-size:13.5px;}
.langmenu summary{list-style:none;cursor:pointer;color:var(--text-dim);padding:2px 4px;}
.langmenu summary::-webkit-details-marker{display:none;}
.langmenu summary:hover{color:var(--text);}
.langmenu[open] .langmenu-list{display:flex;}
.langmenu-list{display:none;position:absolute;right:0;top:130%;flex-direction:column;gap:2px;
  background:var(--glass-bg,rgba(28,28,34,.95));border:1px solid var(--glass-brd,rgba(255,255,255,.08));
  border-radius:9px;padding:6px;min-width:120px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:20;}
.langmenu-list a{padding:5px 10px;border-radius:6px;text-decoration:none;color:var(--text-dim);white-space:nowrap;}
.langmenu-list a:hover{color:var(--text);background:rgba(255,255,255,.05);}
.langmenu-list a[aria-current="true"]{color:var(--text);font-weight:600;}
```

(If `docs.css` does not define `--glass-bg`/`--glass-brd`, the fallbacks in the rules above apply.)

- [ ] **Step 7: Run tests + regenerate**

Run: `python3 -m unittest scripts/test_gen_docs.py -v && python3 scripts/gen-docs.py`
Expected: PASS; output regenerated. Open `web/docs/ja/index.html` in a browser — the language menu shows all four, current marked, links navigate to the right locale URL.

- [ ] **Step 8: Commit**

```bash
git add scripts/gen-docs.py scripts/test_gen_docs.py docs-src/layout.html docs-src/assets/docs.css web/docs
git commit -m "feat(docs): 4-locale language menu"
```

## Task B3: Translate docs chrome (nav.json + strings.json) + add fallback notice

**Files:**
- Modify: `docs-src/nav.json` (add `ja`/`ko` to every `title`/`desc`)
- Modify: `docs-src/strings.json` (add `ja`/`ko` objects + `pendingNotice` key)
- Modify: `scripts/gen-docs.py` (render the pending notice on fallback pages)
- Modify: `docs-src/layout.html` (notice placeholder)
- Modify: `docs-src/assets/docs.css` (notice styling)
- Test: `scripts/test_gen_docs.py` (extend)

**Interfaces:**
- Consumes: `is_translated` (B1), `strings` dict (B1).
- Produces: `{{NOTICE}}` placeholder filled with a localized banner only when the page body is an EN fallback.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test_gen_docs.py`:

```python
class TestChrome(unittest.TestCase):
    def setUp(self): gen.build()
    def test_nav_titles_have_ja_ko(self):
        nav = gen.load_nav()
        for slug, page in nav["pages"].items():
            self.assertIn("ja", page["title"], f"{slug} title missing ja")
            self.assertIn("ko", page["title"], f"{slug} title missing ko")
    def test_strings_have_ja_ko(self):
        s = gen.load_strings()
        self.assertIn("ja", s); self.assertIn("ko", s)
        self.assertIn("pendingNotice", s["ja"])
    def test_fallback_page_shows_notice(self):
        html = (ROOT / "web/docs/ja/index.html").read_text()
        self.assertIn(gen.load_strings()["ja"]["pendingNotice"], html)
    def test_translated_page_no_notice(self):
        # EN page is canonical -> never shows the notice
        html = (ROOT / "web/docs/index.html").read_text()
        self.assertNotIn('class="pending-notice"', html)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest scripts/test_gen_docs.py -v`
Expected: FAIL — nav titles lack `ja`/`ko`; `strings` lacks `ja`/`ko`/`pendingNotice`.

- [ ] **Step 3: Translate `strings.json`**

Add `ja` and `ko` objects and a `pendingNotice` key to all four locales (English `pendingNotice` is unused but keep the schema uniform). Full file:

```json
{
  "en": {
    "brand": "OpenEnlarge", "docs": "Docs", "onThisPage": "On this page",
    "site": "Home", "github": "GitHub", "download": "Download",
    "langSwitch": "中文", "footer": "OpenEnlarge — open-source film scan editor · MIT licensed",
    "skip": "Skip to content", "menu": "Menu",
    "pendingNotice": "This page isn't translated yet — showing the English version."
  },
  "zh": {
    "brand": "OpenEnlarge", "docs": "文档", "onThisPage": "本页目录",
    "site": "主页", "github": "GitHub", "download": "下载",
    "langSwitch": "EN", "footer": "OpenEnlarge —— 开源胶片扫描编辑器 · MIT 许可",
    "skip": "跳到正文", "menu": "菜单",
    "pendingNotice": "本页尚未翻译 —— 显示英文版本。"
  },
  "ja": {
    "brand": "OpenEnlarge", "docs": "ドキュメント", "onThisPage": "このページの内容",
    "site": "ホーム", "github": "GitHub", "download": "ダウンロード",
    "langSwitch": "EN", "footer": "OpenEnlarge — オープンソースのフィルムスキャン編集 · MITライセンス",
    "skip": "本文へスキップ", "menu": "メニュー",
    "pendingNotice": "このページはまだ翻訳されていません — 英語版を表示しています。"
  },
  "ko": {
    "brand": "OpenEnlarge", "docs": "문서", "onThisPage": "이 페이지에서",
    "site": "홈", "github": "GitHub", "download": "다운로드",
    "langSwitch": "EN", "footer": "OpenEnlarge — 오픈소스 필름 스캔 편집기 · MIT 라이선스",
    "skip": "본문으로 건너뛰기", "menu": "메뉴",
    "pendingNotice": "이 페이지는 아직 번역되지 않았습니다 — 영어 버전을 표시합니다."
  }
}
```

- [ ] **Step 4: Translate `nav.json`**

For every section `title` and every page `title` and `desc`, add `ja` and `ko` keys alongside the existing `en`/`zh`. Follow the terminology glossary. Example shape:

```json
{ "id": "overview", "title": {"en": "Overview", "zh": "概览", "ja": "概要", "ko": "개요"}, "pages": ["index", "workflow"] }
```
```json
"index": {
  "slug": "index", "section": "overview",
  "title": {"en": "Documentation", "zh": "文档", "ja": "ドキュメント", "ko": "문서"},
  "desc": {"en": "Understand how OpenEnlarge inverts film scans.", "zh": "了解 OpenEnlarge 如何反转胶片扫描件。", "ja": "OpenEnlarge がフィルムスキャンをどのように反転するかを理解します。", "ko": "OpenEnlarge가 필름 스캔을 반전하는 방법을 알아보세요."}
}
```

Translate every entry (do not leave any `ja`/`ko` missing — the test in Step 1 fails otherwise, and a `KeyError` would crash rendering).

- [ ] **Step 5: Render the notice on fallback pages**

In `scripts/gen-docs.py` `render_page`, add to `repl`:

```python
        "NOTICE": (f'<div class="pending-notice">{html.escape(strings[locale]["pendingNotice"])}</div>'
                   if not is_translated(slug, locale) else ""),
```

In `docs-src/layout.html`, add the placeholder just before `{{BODY}}` (inside `<article class="prose">`):

```html
    <article class="prose">{{NOTICE}}{{BODY}}</article>
```

Append notice styling to `docs-src/assets/docs.css`:

```css
.pending-notice{margin:0 0 20px;padding:10px 14px;border-radius:9px;font-size:13.5px;
  color:var(--text-soft,#c8c8ce);background:rgba(244,157,78,.08);border:1px solid rgba(244,157,78,.25);}
```

- [ ] **Step 6: Run tests + regenerate**

Run: `python3 -m unittest scripts/test_gen_docs.py -v && python3 scripts/gen-docs.py`
Expected: PASS (all classes). `web/docs/ja/index.html` shows localized nav/title/breadcrumbs + the Japanese pending notice + English body + `noindex`.

- [ ] **Step 7: Commit**

```bash
git add docs-src/nav.json docs-src/strings.json scripts/gen-docs.py docs-src/layout.html docs-src/assets/docs.css web/docs
git commit -m "feat(docs): Japanese & Korean chrome + EN-fallback notice"
```

---

# Phase C — Marketing landing + blog

Source of truth (new): `web/landing-strings.json` → `python3 scripts/gen-web.py` → per-locale pages under `web/`. The current `web/index.html` and `web/blog.html` become the **English canonical templates** (kept at root). `web/i18n.js` shrinks; `web/releases.js` reads locale from the URL.

## Task C1: Extract landing strings to JSON

**Files:**
- Create: `web/landing-strings.json`
- Test: `scripts/test_gen_web.py` (create — schema check)

**Interfaces:**
- Produces: `web/landing-strings.json` — `{ "<locale>": { "<key>": "<value>", ... } }` with all keys currently in `i18n.js`'s `STRINGS`, for `en`, `zh` (ported verbatim), `ja`, `ko` (newly translated in Task C4 — for C1 create `ja`/`ko` as copies of `en` placeholders so the schema is complete and the generator runs; C4 fills real translations).

- [ ] **Step 1: Write the failing test**

Create `scripts/test_gen_web.py`:

```python
import json, pathlib, unittest
ROOT = pathlib.Path(__file__).resolve().parent.parent

class TestStringsSchema(unittest.TestCase):
    def test_all_locales_same_keys(self):
        data = json.loads((ROOT / "web/landing-strings.json").read_text())
        self.assertEqual(set(data.keys()), {"en", "zh", "ja", "ko"})
        base = set(data["en"].keys())
        for lc in ("zh", "ja", "ko"):
            self.assertEqual(set(data[lc].keys()), base, f"{lc} key set differs from en")

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest scripts/test_gen_web.py -v`
Expected: FAIL — `web/landing-strings.json` does not exist.

- [ ] **Step 3: Create `web/landing-strings.json`**

Port the `en` and `zh` objects verbatim from `web/i18n.js`'s `STRINGS` (lines 8–223) into JSON. Create `ja` and `ko` as exact copies of `en` for now (placeholders; translated in C4). Structure:

```json
{
  "en": { "meta.title": "OpenEnlarge — Open-source film scan editor", "...": "... all keys ..." },
  "zh": { "meta.title": "OpenEnlarge — 开源胶片扫描编辑", "...": "..." },
  "ja": { "meta.title": "OpenEnlarge — Open-source film scan editor", "...": "copy of en" },
  "ko": { "meta.title": "OpenEnlarge — Open-source film scan editor", "...": "copy of en" }
}
```

Keep every key present in `i18n.js` (`meta.*`, `nav.*`, `blog.*`, `hero.*`, `featured.label`, `quote.*`, `features.*`, `step.*`, `tag.*`, `how.*`, `gallery.*`, `road.*`, `dl.*`, `footer.*`). Preserve the embedded HTML in `hero.h1`, `footer.left`, `footer.right`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest scripts/test_gen_web.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/landing-strings.json scripts/test_gen_web.py
git commit -m "chore(web): extract landing strings to JSON (en/zh; ja/ko placeholder)"
```

## Task C2: Write `gen-web.py` to emit per-locale static landing + blog pages

The generator reads the English `index.html`/`blog.html` as templates, substitutes `data-i18n`/`data-i18n-html` text per locale, sets `<html lang>`, localized `<title>`/`<meta description>`, injects `hreflang` + canonical, rewrites internal links, and writes locale copies. English stays at root; `zh`/`ja`/`ko` go under prefixes.

**Files:**
- Create: `scripts/gen-web.py`
- Modify: `web/index.html`, `web/blog.html` (add SEO placeholder comments — see Step 3)
- Test: `scripts/test_gen_web.py` (extend)

**Interfaces:**
- Consumes: `web/landing-strings.json`.
- Produces: `web/<locale>/index.html`, `web/<locale>/blog.html` for `zh`/`ja`/`ko`; rewrites `web/index.html`/`web/blog.html` in place to add SEO head tags for `en`. Emits `web/sitemap.xml`.
- Page→keys mapping: `index.html` uses default head keys `meta.title`/`meta.desc`; `blog.html` uses `blog.metaTitle`/`blog.metaDesc` (matching the current `data-i18n-title`/`data-i18n-desc` on its `<html>` element).

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test_gen_web.py`:

```python
import importlib.util
spec = importlib.util.spec_from_file_location("gen_web", ROOT / "scripts" / "gen-web.py")

class TestGenWeb(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        gw = importlib.util.module_from_spec(spec); spec.loader.exec_module(gw)
        cls.gw = gw; gw.build()
    def test_locale_pages_exist(self):
        for lc in ("zh", "ja", "ko"):
            self.assertTrue((ROOT / f"web/{lc}/index.html").exists(), f"{lc} index missing")
            self.assertTrue((ROOT / f"web/{lc}/blog.html").exists(), f"{lc} blog missing")
    def test_html_lang_set(self):
        self.assertIn('<html lang="ja"', (ROOT / "web/ja/index.html").read_text())
        self.assertIn('lang="zh-Hans"', (ROOT / "web/zh/index.html").read_text())
    def test_hreflang_reciprocal(self):
        html = (ROOT / "web/index.html").read_text()
        self.assertIn('hreflang="ja"', html)
        self.assertIn('hreflang="ko"', html)
        self.assertIn('hreflang="x-default"', html)
    def test_canonical_self(self):
        self.assertIn('rel="canonical" href="https://openenlarge.io/ja/"', (ROOT / "web/ja/index.html").read_text())
    def test_text_baked_in(self):
        # zh hero text appears in the served HTML (crawlable, not JS-only)
        self.assertIn("开源", (ROOT / "web/zh/index.html").read_text())
    def test_internal_links_localized(self):
        # in /zh/, the Docs nav link points at the zh docs
        self.assertIn('/docs/zh/index.html', (ROOT / "web/zh/index.html").read_text())
    def test_sitemap_lists_locales(self):
        sm = (ROOT / "web/sitemap.xml").read_text()
        for u in ("https://openenlarge.io/", "https://openenlarge.io/zh/",
                  "https://openenlarge.io/ja/", "https://openenlarge.io/ko/"):
            self.assertIn(u, sm)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest scripts/test_gen_web.py -v`
Expected: FAIL — `scripts/gen-web.py` does not exist.

- [ ] **Step 3: Add SEO placeholder markers to the English templates**

The generator needs a deterministic spot to inject per-locale head tags. In **both** `web/index.html` and `web/blog.html`, add a marker comment in `<head>` immediately after the `<link rel="icon" ...>` line:

```html
<link rel="icon" href="img/favicon.png">
<!--OE-SEO-->
```

This single marker is replaced with `<link rel="canonical">` + all `hreflang` alternates for every generated page (including the English root, which the generator rewrites in place). Leave the existing `data-i18n` attributes and the `<title>`/`<meta name="description">` as-is — the generator overwrites their content per locale.

- [ ] **Step 4: Implement `scripts/gen-web.py`**

```python
#!/usr/bin/env python3
"""Generate per-locale static landing + blog pages from the English templates.

web/index.html and web/blog.html are the English (canonical) source. This script
bakes translated text (from web/landing-strings.json) into per-locale copies under
web/<locale>/, sets <html lang>, localized <title>/<meta>, canonical + hreflang, and
rewrites internal links to stay within the active locale. English is rewritten in
place at the root. Run from repo root:  python3 scripts/gen-web.py
Never hand-edit web/<locale>/ output.
"""
import json, pathlib, re, html

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SITE = "https://openenlarge.io"
LOCALES = ["en", "zh", "ja", "ko"]
HREFLANG = {"en": "en", "zh": "zh-Hans", "ja": "ja", "ko": "ko"}
# page -> (template filename, title key, desc key, site path stem)
PAGES = {
    "index": ("index.html", "meta.title", "meta.desc", ""),
    "blog":  ("blog.html", "blog.metaTitle", "blog.metaDesc", "blog.html"),
}

def strings():
    return json.loads((WEB / "landing-strings.json").read_text())

def url_for(stem, locale):
    base = f"{SITE}/" if locale == "en" else f"{SITE}/{locale}/"
    return base + stem  # stem "" -> directory URL; "blog.html" -> file

def out_path(page, locale):
    fname = PAGES[page][0]
    return WEB / (fname if locale == "en" else f"{locale}/{fname}")

def seo_head(page, locale):
    stem = PAGES[page][3]
    canon = url_for(stem, locale)
    alts = [f'<link rel="canonical" href="{canon}">']
    for lc in LOCALES:
        alts.append(f'<link rel="alternate" hreflang="{HREFLANG[lc]}" href="{url_for(stem, lc)}">')
    alts.append(f'<link rel="alternate" hreflang="x-default" href="{url_for(stem, "en")}">')
    return "\n".join(alts)

def localize_links(doc, locale):
    """Rewrite same-site internal links so navigation stays within the locale.
    - Docs link: /docs/index.html -> /docs/<locale>/index.html (en unchanged)
    - Blog/home cross-links within the landing set get the locale prefix.
    Anchor (#...), external (http), and asset (img/, *.js, *.css, releases*.json) links are left alone."""
    if locale == "en":
        return doc
    # docs root link
    doc = doc.replace('href="/docs/index.html"', f'href="/docs/{locale}/index.html"')
    doc = doc.replace('href="/docs/"', f'href="/docs/{locale}/"')
    # landing cross-links (root-absolute forms used in the nav)
    doc = doc.replace('href="/blog"', f'href="/{locale}/blog.html"')
    doc = doc.replace('href="/index.html"', f'href="/{locale}/index.html"')
    doc = doc.replace('href="/"', f'href="/{locale}/"')
    return doc

def fix_asset_paths(doc, locale):
    """Locale pages live one directory deeper; make root-relative asset refs absolute.
    The templates use relative refs like src="img/..", "i18n.js", "releases.js",
    href="img/..", and fetch('./releases.json') in releases.js (handled there).
    Convert leading relative asset refs to root-absolute so they resolve from /<locale>/."""
    if locale == "en":
        return doc
    doc = re.sub(r'(src|href)="(?!https?:|/|#|mailto:)([^"]+)"', r'\1="/\2"', doc)
    return doc

def apply_strings(doc, st, locale, page):
    s = st[locale]
    base_en = st["en"]
    def tr(key):
        return s.get(key) or base_en.get(key) or key
    # <html lang>
    doc = re.sub(r'<html lang="[^"]*"', f'<html lang="{HREFLANG[locale]}"', doc, count=1)
    # title + description (page-specific keys)
    _, tkey, dkey, _ = PAGES[page]
    doc = re.sub(r"<title[^>]*>.*?</title>", f"<title>{html.escape(tr(tkey))}</title>", doc, count=1, flags=re.S)
    doc = re.sub(r'(<meta name="description" content=")[^"]*(")',
                 lambda m: m.group(1) + html.escape(tr(dkey)) + m.group(2), doc, count=1)
    # data-i18n (textContent) — replace inner text
    def sub_text(m):
        return f'{m.group(1)}>{html.escape(tr(m.group(2)))}</{m.group(3)}>'
    doc = re.sub(r'(<(\w+)[^>]*\bdata-i18n="([^"]+)"[^>]*)>.*?</\2>',
                 lambda m: m.group(1) + ">" + html.escape(tr(m.group(3))) + "</" + m.group(2) + ">",
                 doc, flags=re.S)
    # data-i18n-html (innerHTML) — replace inner markup, do NOT escape
    doc = re.sub(r'(<(\w+)[^>]*\bdata-i18n-html="([^"]+)"[^>]*)>.*?</\2>',
                 lambda m: m.group(1) + ">" + tr(m.group(3)) + "</" + m.group(2) + ">",
                 doc, flags=re.S)
    return doc

def render(page, locale, st):
    template = (WEB / PAGES[page][0]).read_text()
    # strip any prior generated marker expansion: re-read always uses the EN template head marker
    doc = template
    doc = apply_strings(doc, st, locale, page)
    doc = doc.replace("<!--OE-SEO-->", seo_head(page, locale))
    doc = localize_links(doc, locale)
    doc = fix_asset_paths(doc, locale)
    return doc

def write_sitemap():
    urls = []
    for page in PAGES:
        stem = PAGES[page][3]
        for lc in LOCALES:
            loc = url_for(stem, lc)
            links = "".join(f'<xhtml:link rel="alternate" hreflang="{HREFLANG[l]}" href="{url_for(stem, l)}"/>' for l in LOCALES)
            urls.append(f"<url><loc>{loc}</loc>{links}</url>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
           'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + "\n".join(urls) + "\n</urlset>\n")
    (WEB / "sitemap.xml").write_text(xml)

def build():
    st = strings()
    # English first: the templates ARE the en source; render(en) re-bakes en text
    # (idempotent) and injects the SEO marker, then writes back to root.
    for page in PAGES:
        for lc in LOCALES:
            p = out_path(page, lc)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(render(page, lc, st))
    write_sitemap()
    print(f"wrote {len(PAGES)*len(LOCALES)} landing pages + sitemap")

if __name__ == "__main__":
    build()
```

> **Idempotency note:** `render("index","en")` rewrites `web/index.html` in place. Because the only structural change is replacing `<!--OE-SEO-->` with the canonical/hreflang block, and the marker is consumed, re-running `build()` would lose the marker. To keep the English template re-runnable, the generator must NOT consume the marker in the source file. Implement this in the next step.

- [ ] **Step 5: Make English-in-place generation idempotent**

The English root files are both template and output. Re-running must not destroy the `<!--OE-SEO-->` marker or double-bake. Fix by treating the marker as re-insertable: in `render`, before injecting SEO, normalize any previously-injected block back to the marker. Add this near the top of `render`, right after reading the template:

```python
    # Normalize: collapse a previously generated canonical+hreflang block back to the marker,
    # so re-running build() on the in-place English file stays idempotent.
    doc = re.sub(r'<link rel="canonical"[^>]*>(?:\s*<link rel="alternate"[^>]*>)+',
                 "<!--OE-SEO-->", doc, count=1)
```

Then keep the `doc.replace("<!--OE-SEO-->", seo_head(...))` line. Verify idempotency in Step 6.

- [ ] **Step 6: Run tests + verify idempotency**

Run:
```bash
python3 scripts/gen-web.py && cp web/index.html /tmp/oe_idem1.html && python3 scripts/gen-web.py && diff web/index.html /tmp/oe_idem1.html && echo IDEMPOTENT
python3 -m unittest scripts/test_gen_web.py -v
```
Expected: prints `IDEMPOTENT` (second run byte-identical); all tests PASS.

- [ ] **Step 7: Verify the English root is visually unchanged**

Run: `git diff --stat web/index.html web/blog.html`
Expected: the only diff vs. the committed English files is the injected `<!--OE-SEO-->` → canonical/hreflang block (plus the marker comment added in Step 3). The visible `<body>` text must be unchanged (English `data-i18n` values re-baked identically). If any visible text changed, a `tr()`/regex bug exists — fix before committing.

- [ ] **Step 8: Commit**

```bash
git add scripts/gen-web.py scripts/test_gen_web.py web/index.html web/blog.html web/zh web/ja web/ko web/sitemap.xml
git commit -m "feat(web): per-locale static landing + blog pages with hreflang"
```

## Task C3: Rewire `i18n.js` (URL-derived locale + navigation) and `releases.js`

Text is now baked per URL, so `i18n.js` no longer swaps page text. It derives the locale from the path, exposes `window.OE.t`/`.locale` for `releases.js`, and turns the language control into navigation between locale URLs.

**Files:**
- Modify: `web/i18n.js`
- Modify: `web/releases.js` (no functional change required — verify it reads `OE.locale`/`OE.t` correctly; adjust the `oe-locale` dependency)
- Modify: `web/index.html`, `web/blog.html` (language control: keep the `#lang-toggle` button but it now navigates; regenerate via gen-web so the change lands in all locales)

**Interfaces:**
- Consumes: `web/landing-strings.json` (for `OE.t` used by `releases.js` OS labels).
- Produces: `window.OE = { t, locale }` where `locale` is derived from `location.pathname` (`/ja/...` → `ja`, `/zh/...` → `zh`, `/ko/...` → `ko`, else `en`). The `#lang-toggle` opens/navigates to the sibling-locale URL.

- [ ] **Step 1: Rewrite `web/i18n.js`**

```javascript
// Per-URL i18n for the landing/blog pages. Text is baked into each locale's static
// HTML by scripts/gen-web.py, so this runtime no longer swaps page text. It:
//  - derives the active locale from the URL path,
//  - exposes window.OE = { t, locale } so releases.js can localize OS-aware labels,
//  - turns #lang-toggle into a language menu that navigates to the sibling-locale URL.
window.OE = (function () {
  var LOCALES = ["en", "zh", "ja", "ko"];
  var LABELS = { en: "English", zh: "中文", ja: "日本語", ko: "한국어" };

  function localeFromPath() {
    var seg = (location.pathname.split("/")[1] || "").toLowerCase();
    return LOCALES.indexOf(seg) > 0 ? seg : "en";
  }
  var locale = localeFromPath();

  // STRINGS are fetched once for OE.t (used by releases.js for OS-specific labels).
  var STRINGS = { en: {}, zh: {}, ja: {}, ko: {} };
  function t(key) {
    return (STRINGS[locale] && STRINGS[locale][key]) || STRINGS.en[key] || key;
  }

  // Resolve the path to landing-strings.json from any locale depth (root or /<locale>/).
  function stringsUrl() {
    return (locale === "en" ? "" : "../") + "landing-strings.json";
  }

  // Compute the sibling URL for a target locale, preserving the current page (index|blog).
  function siblingUrl(target) {
    var isBlog = /blog\.html$/.test(location.pathname);
    var page = isBlog ? "blog.html" : "";
    var base = target === "en" ? "/" : "/" + target + "/";
    return base + page;
  }

  function wireToggle() {
    var toggle = document.getElementById("lang-toggle");
    if (!toggle) return;
    // Cycle to the next locale on click (simple, dependency-free; matches the old button UX).
    var idx = LOCALES.indexOf(locale);
    var next = LOCALES[(idx + 1) % LOCALES.length];
    toggle.textContent = LABELS[next];
    toggle.addEventListener("click", function () { location.href = siblingUrl(next); });
  }

  function init() {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : locale;
    wireToggle();
    fetch(stringsUrl(), { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) STRINGS = data;
        // Let releases.js (and anything else) re-localize now that strings are loaded.
        window.dispatchEvent(new CustomEvent("oe-locale", { detail: locale }));
      })
      .catch(function () { /* offline / blocked: OE.t falls back to keys */ });
  }
  init();

  return { t: t, get locale() { return locale; } };
})();
```

- [ ] **Step 2: Confirm `releases.js` still works**

`releases.js` calls `window.OE.t(...)` and listens for `oe-locale`. The rewrite still fires `oe-locale` (once strings load) and still exposes `OE.t`. **One fix:** `releases.js` does `fetch("./releases.json")` and `fetch("./releases-alpha.json")` — from `/ja/index.html` these resolve to `/ja/releases.json`, which won't exist. Change both fetches to climb to root when in a locale subdir. Edit `web/releases.js`:

Replace `fetch("./releases.json", ...)` with:
```javascript
  var REL_BASE = (window.OE && window.OE.locale && window.OE.locale !== "en") ? "../" : "./";
  fetch(REL_BASE + "releases.json", { cache: "no-cache" })
```
and `fetch("./releases-alpha.json", ...)` with:
```javascript
  fetch(REL_BASE + "releases-alpha.json", { cache: "no-cache" })
```
Define `REL_BASE` once near the top of the IIFE (after `detectOS()` call site) so both fetches share it.

- [ ] **Step 3: Regenerate so the JS changes propagate**

`i18n.js`/`releases.js` are referenced by every page and are not templated, but the per-locale HTML must still point at them with correct (root-absolute) paths. The `fix_asset_paths` step in `gen-web.py` already rewrites `src="i18n.js"` → `src="/i18n.js"` for locale pages. Regenerate and confirm:

Run: `python3 scripts/gen-web.py`
Expected: locale pages reference `/i18n.js` and `/releases.js` (root-absolute); English root still references them relatively.

- [ ] **Step 4: Manual browser test (record result)**

Serve `web/` locally: `python3 -m http.server -d web 8099`. Visit:
- `http://localhost:8099/` — English, language button shows the next locale (中文); clicking navigates to `/zh/`.
- `http://localhost:8099/ja/` — Japanese text baked in (view-source shows it), `<html lang="ja">`, download buttons populate (releases.json fetched from root), language button cycles to 한국어.
- `http://localhost:8099/zh/blog.html` — Chinese blog, nav Docs link → `/docs/zh/index.html`.

Expected: all of the above hold; no JS console errors; download links resolve.

- [ ] **Step 5: Commit**

```bash
git add web/i18n.js web/releases.js web/index.html web/blog.html web/zh web/ja web/ko
git commit -m "feat(web): URL-derived locale runtime + locale-aware release fetch"
```

## Task C4: Translate landing strings to `ja`/`ko`; regenerate

**Files:**
- Modify: `web/landing-strings.json` (fill real `ja`/`ko`)
- Regenerate: `web/ja/**`, `web/ko/**`, `web/sitemap.xml`

- [ ] **Step 1: Translate the `ja` and `ko` objects**

Replace the placeholder (en-copy) `ja` and `ko` values in `web/landing-strings.json` with real translations of every key, using the terminology glossary. Preserve embedded HTML/markup in `hero.h1` (the `<br>` and `<span class="grad">…</span>`), `footer.left`, `footer.right` — translate only the human text, keep tags/attributes/URLs intact. Keep leading glyphs like `↓`, `★`, `◆`, `⊙`, `✦` and the `01 ·`/`02 ·` numbering.

Verify key parity still holds:

Run: `python3 -m unittest scripts/test_gen_web.py -v`
Expected: PASS (`test_all_locales_same_keys`).

- [ ] **Step 2: Regenerate**

Run: `python3 scripts/gen-web.py && python3 -m unittest scripts/test_gen_web.py -v`
Expected: `wrote 8 landing pages + sitemap`; all tests PASS. `web/ja/index.html` and `web/ko/index.html` now contain Japanese/Korean text.

- [ ] **Step 3: Spot-check rendered pages**

Run: `python3 -m http.server -d web 8099` and open `/ja/` and `/ko/`. Confirm hero, nav, steps, download section read naturally; no raw keys; embedded links in footer work.

- [ ] **Step 4: Commit**

```bash
git add web/landing-strings.json web/ja web/ko web/sitemap.xml
git commit -m "feat(web): Japanese & Korean landing + blog translations"
```

---

# Phase D — Build integration & final verification

## Task D1: Document/automate the regen step and verify the whole site

**Files:**
- Modify: `scripts/` (optional convenience runner) and/or a short note in the repo's web/docs README if one exists.
- Verify only: no new source.

- [ ] **Step 1: Confirm deploy includes generated output**

`deploy-web.yml` uploads `web/` directly (no build). Confirm all generated artifacts are committed: `web/docs/**` (incl. `ja`/`ko`), `web/zh|ja|ko/**`, `web/sitemap.xml`, `web/landing-strings.json`.

Run: `git status --porcelain web | head` — Expected: clean (everything committed).

- [ ] **Step 2: Add a one-shot regen convenience script**

Create `scripts/gen-all.sh`:

```bash
#!/usr/bin/env bash
# Regenerate every localized artifact. Run from repo root before committing site changes.
set -euo pipefail
python3 scripts/gen-i18n.py
python3 scripts/gen-docs.py
python3 scripts/gen-web.py
echo "all generators ran"
```

Run: `chmod +x scripts/gen-all.sh && ./scripts/gen-all.sh`
Expected: all three run clean.

- [ ] **Step 3: Run the full test suite**

Run: `python3 -m unittest scripts/test_gen_i18n.py scripts/test_gen_docs.py scripts/test_gen_web.py -v`
Expected: all PASS.

- [ ] **Step 4: Final hreflang/SEO sanity check**

Run:
```bash
grep -c 'hreflang' web/index.html web/ja/index.html web/docs/index.html
grep -l 'noindex' web/docs/ja/*.html | head
```
Expected: landing pages list 5 hreflang lines each (en/zh/ja/ko + x-default); untranslated docs pages carry `noindex`; the English docs index does **not** advertise `hreflang="ja"` until a real `index.ja.html` exists.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-all.sh
git commit -m "chore: add gen-all.sh convenience runner for localized artifacts"
```

---

## Self-Review Notes (coverage map)

- **Spec §1 App** → Phase A (A1 generator generalization, A2 CSV/types/regen/validation/smoke).
- **Spec §2 Docs chrome + EN fallback + noindex + hreflang exclusion** → B1 (fallback/noindex/url generalization), B3 (chrome translation + notice). hreflang exclusion verified in B1 tests + D1 Step 4.
- **Spec §2 4-locale language switcher** → B2.
- **Spec §3 Landing per-locale URLs + hreflang + baked text** → C2; **string extraction** → C1; **i18n.js/releases.js rewire** → C3; **ja/ko translation** → C4; **stale-bookmark affordance** → see note below.
- **Spec build integration** → D1.

**Deferred from spec (intentional, flagged):** the spec's optional "View in <lang>" affordance for stale `oe_locale` bookmarks on `/` is **not** implemented — the rewrite simply derives locale from the URL with no auto-redirect (which the spec preferred). If desired later, add a small client check in `i18n.js` comparing `localStorage.oe_locale` to the URL locale and rendering a dismissible banner; this is additive and does not affect SEO. Left out per YAGNI unless the user wants it.
