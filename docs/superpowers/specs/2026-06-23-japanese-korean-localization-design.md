# Japanese & Korean Localization (app + website + docs) — Design

**Date:** 2026-06-23
**Status:** Approved design, pending implementation plan

## Goal

Add Japanese (`ja`) and Korean (`ko`) alongside the existing English (`en`) and
Chinese (`zh`) across all three OpenEnlarge surfaces:

1. **Desktop app** (Svelte) — UI strings.
2. **Documentation site** (`docs-src/` → `web/docs/`) — chrome translated now; long-form
   page bodies fall back to English until human translations land.
3. **Marketing landing + blog** (`web/`) — converted from client-side text-swapping on a
   single URL to **per-locale static URLs with reciprocal `hreflang`**, for SEO.

### Decisions (locked)

- **Translation source:** I translate all *UI / nav / chrome* strings (app + web + docs)
  to `ja`/`ko` now. Doc page **bodies** fall back to English until a human translation file
  is supplied.
- **Landing SEO:** convert landing/blog to per-locale static URLs + `hreflang` (matches the
  docs model). No more single-URL client-side language switching for indexable text.
- **Scope:** all three subsystems in this effort.

### Non-goals

- Human-quality translation of long-form documentation prose (deferred; structure is wired
  so a `{slug}.ja.html` / `{slug}.ko.html` file is all that's needed later).
- Right-to-left languages, pluralization frameworks, or runtime locale negotiation beyond
  what already exists.

---

## Section 1 — Desktop app (Svelte)

The app's strings are generated: `i18n-strings.csv` → `python3 scripts/gen-i18n.py` →
`app/src/lib/i18n/dict.ts` (never edit `dict.ts` by hand — regeneration drops hand-added keys).

### Changes

1. **`i18n-strings.csv`** — insert two columns so the header becomes
   `key,en,zh,ja,ko,file,note`. Populate `ja` and `ko` for all ~479 rows.
2. **`scripts/gen-i18n.py`** — add `ja`/`ko` dict comprehensions and emit them into the
   generated `dict` object (currently only `en`/`zh` on lines ~23–30).
3. **`app/src/lib/i18n/index.ts`**
   - Widen `export type Locale = "en" | "zh" | "ja" | "ko";`
   - Extend `LOCALES` with `{ id: "ja", label: "日本語" }` and `{ id: "ko", label: "한국어" }`.
4. **`app/src/lib/catalog.ts`** — widen the persisted-pref validation (line ~69) so `ja`/`ko`
   are accepted. Prefer a membership check against `LOCALES` over a hardcoded `||` chain, to
   avoid this drifting again on the next locale.
5. Run `python3 scripts/gen-i18n.py` and commit both the CSV and regenerated `dict.ts`.

The existing lookup fallback (`dict[l]?.[key] ?? dict.en[key] ?? key`) already guarantees a
missing `ja`/`ko` string degrades to English then to the raw key — no crash path to add.

### Verification

- `python3 scripts/gen-i18n.py` runs clean; `dict.ts` contains `ja:` and `ko:` blocks with
  all keys.
- App typechecks/builds.
- Settings menu shows four language buttons; selecting 日本語 / 한국어 switches UI text and the
  choice persists across restart.

---

## Section 2 — Documentation site (Python static gen) with SEO-correct EN fallback

Source of truth: `docs-src/` (nav.json, strings.json, layout.html, `content/{slug}.{locale}.html`,
figures, assets) → `python3 scripts/gen-docs.py` → `web/docs/`. English at `/docs/`, others under
a locale prefix (`/docs/zh/`, new `/docs/ja/`, `/docs/ko/`).

### Translate the chrome (now)

- **`docs-src/nav.json`** — every section `title` and every page `title`/`desc` gains `ja`/`ko` keys.
- **`docs-src/strings.json`** — add full `ja` and `ko` objects (brand, docs, onThisPage, site,
  github, download, skip, menu, and the language-switch label).

### Body fallback rule

For each renderable page and each of `ja`/`ko`: if `content/{slug}.{locale}.html` exists, use it;
otherwise use the English body (`{slug}.en.html`). The page is still generated for navigation.

### SEO handling of fallback bodies (the important part)

A locale page whose **body is the English fallback** is treated as *not yet a real translation*:

- It is emitted with `<meta name="robots" content="noindex,follow">`.
- It is **excluded from the `hreflang` alternate set** and from the sitemap's alternate links
  (and itself omitted from the sitemap) until a genuine `{slug}.{locale}.html` exists.
- A small **localized "translation in progress" notice** renders at the top of the body.

This prevents duplicate-content penalties: search engines only see a locale indexed once its
content is genuinely translated, while users can still browse the localized chrome + English body.
When a real `{slug}.ja.html` is later added, regeneration automatically flips that page to
indexable and wires it into `hreflang` + sitemap — no code change needed.

### Generator generalization (`scripts/gen-docs.py`)

The script currently hardcodes a two-locale (en/zh) world; generalize it:

- `LOCALES = ["en", "zh", "ja", "ko"]`.
- **hreflang code map:** replace the inline `"en" if lc=="en" else "zh-Hans"` with a map
  `{en:"en", zh:"zh-Hans", ja:"ja", ko:"ko"}`, used in `seo_blocks()` and `write_sitemap()`.
- **`url_for(slug, locale)`** — locale prefix for any non-en locale (`/docs/<locale>/`), not just zh.
- **`out_path(slug, locale)`** — `<locale>/` subdir for any non-en locale.
- **depth math** (`docsroot`, `siteroot`, `ROOT`) — current `0/1 if en else 1/2` already holds for
  any single-segment locale prefix; just confirm it's keyed on `locale == "en"`, not `== "zh"`.
- **`renderable()`** — require only the **English** content file to exist (canonical); per-locale
  bodies are resolved with fallback at render time. Track per-(slug,locale) whether the body was a
  real translation or a fallback, to drive `noindex`/hreflang exclusion.
- **`seo_blocks()` / sitemap** — build the alternate set from only the locales that have a *real*
  translation for that slug (plus always `x-default` → en). Add `noindex` meta when the current
  page is a fallback.
- **`HTMLLANG`** — `{en:"en", zh:"zh-Hans", ja:"ja", ko:"ko"}`.

### Language switcher (4 locales)

`layout.html` currently has a single binary `{{LANGSWITCHHREF}}` + `{{S_langSwitch}}` link.
Replace with a small **language menu** listing all four locales (current one marked active),
each linking to that locale's URL for the same slug. The generator computes the four hrefs
(reusing the existing relative-path logic) and injects the menu markup. Keep it dependency-free
(a `<details>`/`<summary>` disclosure or a simple inline row — consistent with the site's no-build
ethos).

### Verification

- `python3 scripts/gen-docs.py` runs clean; `web/docs/ja/` and `web/docs/ko/` trees exist.
- A page with no `ja` body: localized nav/title/breadcrumbs + English body + visible notice +
  `robots noindex` + absent from that page's hreflang set and sitemap.
- A page (if any) with a real `ja` body: indexable, present in hreflang + sitemap.
- `hreflang` reciprocity holds among indexable locales; `x-default` always → en.
- Language menu on every page links correctly across all available locales.

---

## Section 3 — Marketing landing + blog → per-locale static URLs

Today `web/index.html` and `web/blog.html` are hand-authored English HTML with `data-i18n`
attributes; `web/i18n.js` swaps `textContent`/`innerHTML` client-side and remembers the choice
in `localStorage`. One URL serves all languages → translated content is effectively invisible to
crawlers, and there are no per-language `hreflang`/canonical signals.

### New model (mirrors docs)

- **`web/landing-strings.json`** — single source of truth for landing + blog chrome strings,
  with `en`/`zh`/`ja`/`ko` objects (ported from the `STRINGS` object currently inside `i18n.js`;
  `ja`/`ko` newly translated).
- **`scripts/gen-web.py`** (new) — treats the existing `index.html` / `blog.html` as templates and
  emits per-locale static pages:
  - English at the root (`/index.html`, `/blog.html`) — canonical + `x-default`.
  - `/zh/`, `/ja/`, `/ko/` variants with the same filenames.
  - Each page: localized `<html lang>` (`en` / `zh-Hans` / `ja` / `ko`), localized `<title>`/`<meta
    name=description>`/Open Graph, **server-side-substituted** body text (resolve `data-i18n` /
    `data-i18n-html` from the JSON), internal links rewritten to stay within the active locale,
    and a reciprocal `hreflang` block (all four + `x-default`).
  - Update/emit `web/sitemap.xml` (or extend the docs one's coverage) to list all locale URLs with
    alternates. Confirm whether a root sitemap already exists; create one if not.
- **`web/i18n.js`** shrinks: it no longer swaps page text. It (a) derives the active locale from the
  URL path (`/ja/…` → `ja`, root → `en`), and (b) turns the language control into **navigation** to
  the sibling-locale URL for the current page. Dynamic content keeps working (see below).
- **`web/releases.js`** (and any other dynamic renderer that listened to the `oe-locale` event):
  read the active locale from the URL/`window.OE.locale` instead of `localStorage`, so dynamically
  injected text (download/release entries) renders in the page's language. The `oe-locale` runtime
  event path can remain for any in-page dynamic re-render, but initial locale comes from the URL.

### Edge cases

- **Existing inbound links / bookmarks** to `/index.html` with a saved `oe_locale`: since text is
  now baked per URL, a returning Chinese user landing on `/` sees English. Add a light,
  non-blocking client-side hint: if `localStorage` locale ≠ URL locale on the root page, surface a
  small "View in 中文/日本語/한국어" affordance (no auto-redirect — auto-redirect on `/` harms SEO and
  UX). Decide final UX during implementation; default is the unobtrusive affordance.
- **Asset paths** (`img/`, CSS, JS) must resolve from locale subdirectories — rewrite relative
  paths like the docs generator does, or use root-absolute paths.

### Verification

- `python3 scripts/gen-web.py` runs clean; `/zh/`, `/ja/`, `/ko/` copies of `index.html`/`blog.html`
  exist with correct `lang`, `title`, baked translated text, and rewritten asset/internal links.
- `hreflang` reciprocity across all four + `x-default` → en; each page's canonical = its own URL.
- Language control navigates to the sibling-locale URL (no text-swap flash).
- `releases.js` renders dynamic content in the page's language.
- `view-source` on `/ja/index.html` shows Japanese text in the HTML (crawlable), not just after JS.
- Root `sitemap.xml` lists all locale URLs with alternates.

---

## Build / release integration

- Confirm how `web/` is built/deployed (Cloudflare Pages). Ensure `gen-docs.py` **and** the new
  `gen-web.py` are run as part of the site build (or document the manual regen step next to the
  existing one). Both follow the repo convention: source is authoritative, generated output under
  `web/` is "do not edit by hand."
- No change to the app's release/auto-update flow.

## Rollout order (for the plan)

1. App (self-contained, mechanical, independently verifiable).
2. Docs generator generalization + chrome translations + fallback/noindex logic.
3. Landing/blog generator + string extraction + `i18n.js`/`releases.js` rewire.

Each is independently shippable and testable.

## Risks

- **Translation quality** for app/web UI is on me now; film/photography terms (e.g. density,
  base, tint) should be reviewed by a native speaker later. Keys are stable, so corrections are
  drop-in.
- **gen-web.py regression risk:** converting hand-authored HTML into a templated generator can
  drift from the current visual output. Mitigate by diffing the generated English `/index.html`
  against the current file (should be byte-identical modulo injected SEO/lang attributes).
- **Stale `oe_locale` bookmarks** changing perceived default language on `/` (handled via the
  affordance above, not redirect).
