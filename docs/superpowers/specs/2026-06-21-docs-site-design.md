# OpenEnlarge Documentation Site — Design Spec

**Date:** 2026-06-21
**Status:** Approved (pending spec review)
**Topic:** A public documentation site explaining the science behind OpenEnlarge's film-negative inversion engine and the tools in Develop, Tune, Library, and Export — optimized for curious readers and SEO.

---

## 1. Goals

- Explain **the science** of OpenEnlarge to people who want to understand how it works: how color inversion is done, how images are analyzed, how tuning works, and what parameter each control actually adjusts (e.g. "what am I tuning when I drag Exposure?").
- Be **discoverable** — strong, technically-correct SEO in both English and Chinese.
- Match the existing marketing site's look and zero-build, static-hosting ethos.
- Stay maintainable: dense bilingual prose without hand-duplicating shared chrome.

### Non-goals

- No `file:line` / source-internals exposure (those belong in the repo, not public docs).
- No new runtime framework, no deploy-time build step, no search backend (Wave 1–3 scope).
- Not a replacement for the marketing site; this is a companion `/docs` section.

---

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Tech & hosting | Static HTML/CSS/JS, served from `web/docs/` on the existing Cloudflare Pages site → `openenlarge.io/docs` |
| Structure | Multi-page with a left sidebar |
| Imagery | Custom inline-SVG diagrams **and** existing UI screenshots |
| Languages | English + Chinese at launch, as distinct indexable URLs |
| Build model | A local generator script (`scripts/gen-docs.py`) emits static HTML; Cloudflare just serves it |

**Why a generator (not client-side i18n like the marketing `i18n.js`):** SEO requires distinct, statically-indexable URLs per language. Client-side language toggling hides the non-default language from crawlers. The generator emits full static HTML per language (`/docs/…` EN, `/docs/zh/…` ZH) with `hreflang` alternates. This mirrors the project's existing `scripts/gen-i18n.py` pattern, which the user already maintains.

---

## 3. Architecture

### 3.1 Source / generated split

```
docs-src/                      ← authoring source (NOT served)
  layout.html                  ← shared shell: <head> template, top nav, sidebar slot, footer
  nav.json                     ← sidebar structure: sections → pages, slug, per-locale title
  strings.json                 ← UI chrome strings (nav labels, "On this page", footer, lang switch) EN/ZH
  content/
    <page>.en.html             ← body fragment: prose + inline SVG figures + screenshot refs
    <page>.zh.html
  figures/                     ← reusable inline-SVG diagram partials (shared across locales)

scripts/gen-docs.py            ← assembles layout + content + nav + strings → web/docs/
                                 (mirrors scripts/gen-i18n.py conventions)

web/docs/                      ← GENERATED + committed + served by Cloudflare Pages
  index.html
  science/*.html
  tools/*.html
  reference/*.html
  zh/{index,science,tools,reference}/*.html   ← full ZH mirror
  docs.css                     ← extends the site glass theme (imports/duplicates tokens)
  docs.js                      ← mobile sidebar toggle, scroll-spy "On this page", language switch
  sitemap.xml
  robots.txt
  og/                          ← OpenGraph share image(s)
```

### 3.2 How the generator works

`gen-docs.py`:
1. Loads `nav.json` (page order/sections) and `strings.json` (chrome).
2. For each page × locale: reads `content/<page>.<locale>.html`, inlines any referenced `figures/*.svg` partials, injects into `layout.html` along with the rendered sidebar (active page highlighted), the per-page `<title>`/`<meta>`/`hreflang`/canonical/JSON-LD, and the "On this page" TOC seed (TOC is finalized client-side by `docs.js` from `<h2>/<h3>`).
3. Writes EN to `web/docs/<section>/<page>.html` and ZH to `web/docs/zh/<section>/<page>.html`.
4. Emits `sitemap.xml` (all pages, both locales, with `xhtml:link` alternates) and `robots.txt`.

The generated `web/docs/**` is committed so the existing `.github/workflows/deploy-web.yml` (deploys `web/**` on push) ships it with no pipeline change.

### 3.3 Authoring rule

Body prose lives in `content/*.html` as **static HTML inline** so each generated page is fully indexable without JS. Only navigational chrome (sidebar links, nav) is generator-injected — and it is emitted as real `<a>` elements, not JS-built, so crawlers follow it. `docs.js` only enhances (mobile toggle, scroll-spy, lang-switch); content never depends on it.

---

## 4. Page map

**Overview**
- `index` — Docs home: what OpenEnlarge is; the "density-domain, not a flipped tone curve" philosophy; how to read these docs; quick links into each section.
- `workflow` — Import → Develop → Tune → Roll → Export, illustrated with `web/img/{library,develop,tune,export}.png`.

**The Science** (centerpiece)
- `science/negatives` — How color negatives work: the orange mask, dye layers, why negatives look orange, the Hurter–Driffield (H-D) characteristic curve.
- `science/inversion` — The inversion pipeline, stage by stage: scan → film-base subtraction → log-density conversion (Beer–Lambert) → channel balance/WB → tone curve → look layer → display encode. The hero diagram.
- `science/density` — Density & log space: optical density, what a photographic "stop" is, why we work in log, the `d_max` white-point anchor.
- `science/tone-curve` — The *Faithful* look: gamma + asymptotic shoulder, true white, toe/shoulder roll-off, why a filmic S-curve beats a naive inverse.
- `science/color` — Color & white balance: gray-world auto-WB, Temp/Tint (correlated colour temperature), Gain vs. Subtractive color-head (CMY / enlarger dichroic head), OKLab perceptual saturation.
- `science/base-calibration` — Film-base calibration: per-roll base sampling (percentile vs. coherent), the film-edge picker, picking the white point.

**Tools reference**
- `tools/develop-basic` — Every Basic control → what it does → what engine parameter it tunes and how. Anchored by the Exposure walkthrough.
- `tools/tune` — Tone Curve editor, Color Grading wheels (3-way/global), Color Mixer (8 bands), Point Color.
- `tools/crop-dust` — Crop & transform; Dust & eraser (manual brush, IR, AI MI-GAN inpaint, auto-dust).
- `tools/ai` — AI Enhance, Color/Tone Match, Upscale.
- `tools/library` — Import & catalog, thumbnails, stale-thumbnail regeneration.
- `tools/roll` — Roll / contact sheet: live mirror mode, film-edge (sprocket/rebate) rendering.
- `tools/export` — Formats (JPEG/TIFF/PNG), bit depth, resolution caps, batch crop, GPU/CPU export path.

**Reference**
- `reference/glossary` — Parameter & constants glossary + film-term glossary.
- `reference/faq` — Common questions (why density-domain, why my scan looks X, IR vs AI dust, etc.).

---

## 5. Content style — layered depth

Each science page follows: **plain-language explanation + a custom SVG diagram first**, then an optional collapsible **"Under the hood"** `<details>` block with the real formula and named constants. Examples of what appears under the hood (concept-level, no source paths):

- Density: `D = log₁₀(base / scan)`; 1.0 density ≈ 3.32 stops.
- Faithful tone: gamma `≈ 1.59`, knee `≈ 0.892`, fixed density scale `1 / 0.700` (so tone is frame-independent).
- Subtractive WB: per-channel density scaled by `gain^1.6`, anchored at black.
- Look layer: a normalized tanh S-curve (strength 2.0) for mid-contrast punch.

This serves both audiences (intuition vs. math) and enriches the page text for SEO. Constants are described as design values, not as code to be copied.

---

## 6. Visual design

- **Tokens (reuse verbatim from `web/index.html`):** `--bg-0:#0a0a0c`, glass `rgba(28,28,34,.55)`, borders `rgba(255,255,255,.08)`, text `#e8e8ea` / dim `#9a9aa2`, accent gradient `#f49d4e → #df7136`. System font stack with CJK fallbacks.
- **Layout:** sticky top nav (glass); sticky **left sidebar** with section groups; centered prose column (~720px max); right-hand **"On this page"** TOC on wide viewports. Sidebar collapses behind a toggle ≤ ~900px.
- **Figures:** custom inline SVG in the same palette — pipeline flow, H-D curve, density→light mapping, orange-mask spectral bars, tone-curve plot (toe/shoulder), gain-vs-color-head comparison, OKLab chroma scaling. Screenshots from `web/img/` shown in glass frames with captions.
- **Main-site integration:** add a **"Docs"** link to the marketing nav (`web/index.html` and `web/blog.html`).

---

## 7. SEO

- Per-page unique `<title>` and `<meta name="description">`.
- `<link rel="canonical">` per page; `hreflang` alternates between EN and ZH (and `x-default`).
- OpenGraph + Twitter Card tags; one shared OG image (plus optionally per-section).
- JSON-LD: `TechArticle` + `BreadcrumbList` on content pages; `SoftwareApplication` on the docs home.
- `sitemap.xml` (both locales with alternate links) and `robots.txt`; link the sitemap from the site.
- Semantic heading hierarchy (one `<h1>`, ordered `<h2>/<h3>`), descriptive `alt` text on every figure/screenshot, meaningful internal linking between science and tools pages, fast static first paint.

---

## 8. Delivery waves

1. **Framework + The Science** — `gen-docs.py`, `layout.html`, `docs.css`, `docs.js`, `nav.json`, `strings.json`; the full *Overview* + *The Science* section in EN+ZH; SEO scaffolding (titles, canonical, hreflang, JSON-LD, sitemap stub); "Docs" nav link on the marketing site.
2. **Tools reference** — all seven tool pages in EN+ZH, with screenshots and param→effect tables.
3. **Reference + polish** — glossary, FAQ, finalized sitemap/structured data, cross-linking pass, OG image, link checks.

Each wave is independently shippable (Cloudflare auto-deploys on push).

---

## 9. Risks & mitigations

- **Bilingual prose volume.** Mitigation: wave-based delivery; ship Science first (the priority); reuse figure partials across locales so only text is duplicated.
- **Technical accuracy of ZH science translation.** Mitigation: translate from the approved EN, keep formulas/constants identical across locales (numbers are language-neutral), favor established Chinese photographic terms.
- **Generator drift / partial regeneration.** Mitigation: `gen-docs.py` always regenerates the whole `web/docs/` tree from source; never hand-edit generated files (document this at the top of each generated file and in `docs-src/README`).
- **Constant accuracy.** Mitigation: source the "under the hood" numbers from the engine constants captured during exploration; describe as design values.

---

## 10. Acceptance criteria

- `python3 scripts/gen-docs.py` regenerates `web/docs/**` deterministically from `docs-src/`.
- Every page exists in EN and ZH with correct `hreflang`/canonical and renders correctly served statically (no JS required for content).
- Sidebar, mobile toggle, scroll-spy TOC, and language switch work.
- Science pages carry plain-language + diagram + "under the hood" layers; tools pages map each control to its effect and underlying parameter.
- `sitemap.xml`, `robots.txt`, per-page meta, and JSON-LD present and valid.
- Visual parity with the marketing site; "Docs" link added to the main nav.
