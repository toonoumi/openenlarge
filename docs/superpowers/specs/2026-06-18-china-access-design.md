# China-Friendly Access — Design

**Date:** 2026-06-18
**Status:** Approved (design); CDN steps detailed
**Scope:** Make the OpenEnlarge website + downloads reliably reachable from mainland China, with **no ICP filing** (no-paperwork / outside-China hosting).

---

## Problem

The site and downloads depend on infrastructure that the Great Firewall (GFW) throttles or blocks:

1. **GitHub Pages** (`*.github.io`, Pages IPs `185.199.108–111`) — intermittently throttled/blocked from mainland China.
2. **`api.github.com` runtime call** in `web/releases.js` — frequently blocked, so download buttons silently fail to populate and fall back to `github.com/releases/latest`...
3. ...which is **`github.com` download links** — slow/throttled.
4. (Secondary) Discord link — blocked. Tauri auto-updater and Aptabase analytics (app-side) also call out to blocked endpoints.

The page itself is otherwise self-contained: fonts use a system stack incl. `PingFang SC` / `Microsoft YaHei`, images are local, and there is no external CDN/analytics JS on the page. So the *only* runtime external dependency on the page is the GitHub API call.

## Decisions (locked)

- **No ICP filing.** Therefore no mainland CDN PoPs; we serve mainland users from Hong Kong / overseas edges.
- **Front the static site with a managed HK-edge CDN** instead of running a self-hosted HK VPS.
- **Provider: Tencent EdgeOne International**, free tier, acceleration region **"Global (excluding mainland China)"** (the no-ICP path). Chosen over Bunny.net / Gcore because EdgeOne has **direct peering with China Telecom / Unicom / Mobile**, giving substantially better mainland performance from overseas/HK nodes, at no cost to start.
- **Domain managed on Cloudflare** (user handles registration/DNS).
- **Downloads** mirrored to **Cloudflare R2**, and also fronted by EdgeOne for China.

### Why EdgeOne over alternatives

| Option | China edge | ICP? | Notes |
|---|---|---|---|
| Mainland CDN (Aliyun/Tencent domestic, CF China Network) | In China 🚀 | **Yes** ❌ | Ruled out (no-paperwork decision) |
| Generic global CDN (Cloudflare, Fastly) | Overseas | No | Same GFW throttle as Cloudflare Pages — best-effort only |
| Bunny.net / Gcore HK | Hong Kong | No | Works, but generic HK PoP without premium China ISP peering |
| **Tencent EdgeOne Intl (chosen)** | HK/overseas + **3-ISP peering** | **No** (region = Global-excl-mainland) | Best no-ICP China perf; free to start |

**Catch to watch:** EdgeOne's *guaranteed* Cross-MLC-border acceleration is an Enterprise feature. The free tier's ISP peering is good but not contractually guaranteed. Plan: start free, measure real mainland latency (17ce.com / itdog.cn), upgrade only if needed.

## Architecture

```
                         ┌──────────────────────────────────────┐
  China visitor ───────► │  Tencent EdgeOne International (edge)  │
                         │  region: Global (excl. mainland China) │ ── origin-pull ──► origin
  Global visitor ──────► │  3-ISP peering · HTTPS · cache rules   │     (HK node → origin,
                         └──────────────────────────────────────┘      outside the GFW)
                                   ▲ CNAME (DNS-only / grey cloud)
                         www.<domain> + apex   (DNS on Cloudflare, no ICP)
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        │ origin: Cloudflare Pages (static site, auto-deploy)   │  ← serves /web
        │ downloads: Cloudflare R2 (installers)  → dl.<domain>  │  ← fronted by EdgeOne too
        └───────────────────────────────────────────────────────┘
```

China users hit the EdgeOne **Hong Kong edge** (with China ISP peering) instead of GitHub's throttled IPs. EdgeOne origin-pulls from Cloudflare Pages over the open internet (the HK PoP is *outside* the GFW, so that hop is unthrottled). Cached globally, so the rest of the world is fast too.

### Origin choice

GitHub Pages currently serves the site as a *project page* (path-scoped), which is awkward to front with a CDN at an apex domain. Move the **serving origin** to **Cloudflare Pages** (free, auto-build/deploy from the same `/web` in the repo). GitHub remains the source of truth; Cloudflare Pages is just the origin EdgeOne pulls from. This keeps everything on one provider (Cloudflare) for DNS + origin + downloads, with EdgeOne layered in front for China.

## Components / changes

### 1. Domain + DNS (Cloudflare) — user
- Register/point domain on Cloudflare.
- Records created later in step 3 must be **DNS-only (grey cloud, not proxied)** so Cloudflare doesn't re-proxy onto its own (throttled-in-China) network and defeat the HK edge.

### 2. Origin on Cloudflare Pages
- Create a Cloudflare Pages project building from the repo, output dir `web/` (static, no build step needed — direct upload of `/web`).
- Exposed at `origin.<domain>` (or use the `*.pages.dev` URL directly as the EdgeOne origin).

### 3. Tencent EdgeOne International — CDN setup (detailed steps below)

### 4. Kill the runtime GitHub dependency (`web/releases.js`)
- Today it calls `api.github.com` in-browser → blocked in China → buttons die.
- **Fix:** `release.yml` writes a static `web/releases.json` at release time:
  ```json
  { "tag": "vX.Y.Z",
    "assets": { "macos": "https://dl.<domain>/...dmg",
                "windows": "https://dl.<domain>/...msi",
                "linux": "https://dl.<domain>/...AppImage" } }
  ```
- `releases.js` fetches `./releases.json` from our own domain (served via EdgeOne) — **zero GitHub calls at runtime**. Keep the OS-detection + localized-label logic; only swap the data source and the URLs.

### 5. Downloads mirror (Cloudflare R2 + EdgeOne)
- `release.yml` uploads installers to GitHub Release **and** Cloudflare R2 on each tag.
- R2 exposed at `dl.<domain>`; `releases.json` points at these URLs (not `github.com`).
- Front `dl.<domain>` with EdgeOne too, so China gets HK-edge delivery for the binaries (more reliable than Cloudflare for mainland).

## EdgeOne CDN setup — concrete steps

Prereqs: Tencent Cloud **International** account (email + credit card KYC; free plan available). Domain DNS on Cloudflare. Origin reachable (Cloudflare Pages or `*.pages.dev`).

1. **Open EdgeOne console** (international) → **Add site** → enter the apex domain (e.g. `openenlarge.xyz`) → **Continue**.
2. **Plan & region:** choose **Free** plan; set **Acceleration region = "Global (excluding Chinese mainland)"**. This is the no-ICP path — do NOT pick "Chinese mainland" or plain "Global" (those demand ICP + identity verification).
3. **Access mode = CNAME Access** (NOT NS access — DNS stays on Cloudflare). EdgeOne shows a **domain-ownership verification record** (TXT or CNAME). Add it in Cloudflare DNS, **DNS-only**. Wait for verification.
4. **Add acceleration domain(s):** Domain Name Service → Domain Management → **Add Domain Name**. Add the public hostnames you serve, e.g. `www` and apex (and `dl` for downloads).
   - **Origin:** type "domain", value = `origin.<domain>` (Cloudflare Pages) or the `*.pages.dev` host. For `dl`, origin = the R2 public host.
   - **Origin-pull protocol:** HTTPS. **HOST header:** the origin hostname.
5. **Get the assigned CNAME target** EdgeOne gives per domain (e.g. `<something>.eo.dnse*.com`).
6. **In Cloudflare DNS:** create CNAME records `www`, apex (CNAME flattening), `dl` → the EdgeOne CNAME targets, each **DNS-only (grey cloud)**.
7. **TLS:** let EdgeOne provision a free certificate (or upload one). Enable **Force HTTPS** redirect + HSTS.
8. **Caching rules:** HTML short TTL (e.g. 5 min) so releases/i18n propagate; hashed assets/images long TTL (e.g. 30 d); `releases.json` short TTL (e.g. 5 min). Enable smart compression (gzip/brotli).
9. **Verify from China:** test mainland latency/reachability from the 3 ISPs via 17ce.com / itdog.cn / boce.com. Confirm `www`, apex, and `dl` all resolve to the EdgeOne edge and load. If free-tier mainland perf is poor, evaluate the paid Cross-MLC-border upgrade.

## Data flow on release (CI)

`git tag vX.Y.Z` → `release.yml` builds installers → uploads to GitHub Release **and** Cloudflare R2 → generates `web/releases.json` (pointing at `dl.<domain>`) → commits to repo → Cloudflare Pages redeploys origin → EdgeOne serves fresh copy at the edge (respecting cache TTLs).

## Out of scope (flagged follow-ups, not built in Phase 1)

- **In-app Tauri auto-updater** — fetches `latest.json` + binaries from GitHub; updates break in China. Fixable by mirroring `latest.json` + binaries to `dl.<domain>` and pointing the updater there. → Phase 2.
- **Aptabase analytics** (app-side) — endpoint may be blocked; degrades silently, low priority.
- **Discord** — blocked in China; consider adding a WeChat/QQ/Bilibili contact later. → Phase 3.

## Phasing

- **Phase 1 (this scope):** Cloudflare Pages origin + EdgeOne HK-edge CDN; de-GitHub `releases.js` via `releases.json`; downloads via R2 + EdgeOne. → *China can reach the site and download reliably.*
- **Phase 2 (optional):** in-app updater mirror.
- **Phase 3 (optional):** China-native community/analytics touches.

## Open questions / risks

- **EdgeOne intl account KYC** (credit card) — minor friction; acceptable.
- **Free-tier mainland performance** is good-but-not-guaranteed; measured in step 9, paid upgrade is the fallback.
- **Apex CNAME** relies on Cloudflare CNAME flattening (supported). If issues, serve the canonical site on `www` and redirect apex.
