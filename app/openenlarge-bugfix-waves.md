# OpenEnlarge — Bugfix Waves (parallel dispatch plan)

Each **Session** below is a separate Claude Code session. Copy the prompt block into a fresh
session. Run a whole wave in parallel; **do not start Wave 2 until Wave 1 Session A is merged**
(it edits the same hot files).

**Hot files (single-owner only):** `src/lib/tabs/Develop.svelte`, `src/lib/develop/Basic.svelte`.
`src-tauri/src/commands.rs` is large — edits to different functions don't conflict.

**Shared root cause:** issues "effect not applied", "first open not inverted", and
"histogram never updates" are probably the *same* stale-preview bug → owned by Session A. Don't
let another session also try to fix the preview path.

---

## Wave 1 — independent lanes + the keystone (run all 4 in parallel)

### Session A — Render/preview truth + busy indicator  ⭐ KEYSTONE
Owns: `Develop.svelte` (render trigger/init), `Basic.svelte` reset, `commands.rs` render, new overlay.

```
Use the systematic-debugging skill. This is the OpenEnlarge/filmrev Tauri app
(SvelteKit frontend in app/src/lib, Rust backend in app/src-tauri/src).

Bug cluster — likely one stale/un-rendered `previewSrc` root cause:
1. Edits look applied on screen but zooming in or exporting shows the effect was NOT
   actually applied. There is no "rendering in progress" indicator, so it's confusing.
2. The FIRST image opened from Develop isn't even inverted (still a negative) and color
   adjustments are completely un-applied, with no loading hint.
3. The live AND locked histogram never update on any operation.
4. Pressing Reset makes the image flip/flicker (re-invert) then settle.

Find the real root cause before fixing — don't guess. Likely the initial `render_view`
doesn't fire with invert+finish, and/or the frontend shows a stale preview frame.

Key files:
- src/lib/tabs/Develop.svelte  (render trigger + init)
- src-tauri/src/commands.rs    (render_view ~908, render_view_compute ~942, invert_image ~1007)
- src/lib/viewport/Histogram.svelte + src/lib/viewport/histogram.ts  (compute() ~11)
- src/lib/develop/Basic.svelte (resetBasic ~215, togglePositive ~231)

Deliverables: (a) preview always reflects the real render; (b) first-open inverts + applies
edits; (c) histogram updates live and when locked; (d) reset no longer flickers; (e) an
explicit "rendering" overlay/spinner while a render is in flight.
Commit on main when done and verify in the running app.
```

### Session B — Color "match" (匹配) is broken
Independent. No hot-file overlap.

```
Use the systematic-debugging skill. OpenEnlarge/filmrev (SvelteKit + Rust/Tauri).

The "Match" feature is unusable: at lowest strength the result is the original color, at
half strength it's half-gray, at max strength saturation is extremely low. The intensity
blend and/or the match optimization is wrong.

Files:
- src/lib/develop/AiEnhancePanel.svelte  (matchToning ~65, applyStrength ~53, strength 0–100)
- src-tauri/src/color_match.rs            (compute_stats ~53, loss ~116, match_to_reference ~257)
- src-tauri/src/commands.rs:2565          (color_match_params)

Make strength a proper 0→100 blend from original toward a correctly-computed match target
(no gray/desaturation artifacts). Commit on main and verify in the app.
```

### Session G — Export dialog: resolution + roll markings
Independent. No hot-file overlap.

```
OpenEnlarge/filmrev (SvelteKit + Rust/Tauri). Two export-dialog issues:
1. Can't choose export resolution — add a resolution selector.
2. The contact-sheet / film-strip roll markings only appear on the far left; the middle and
   right are empty; the font is tiny and doesn't feel editable. Make markings larger,
   distributed across the strip, and clearly editable — consider relocating them next to the
   "output contact sheet" (输出印样) control at the top.

Files:
- src/lib/export/ExportModal.svelte
- src/lib/roll/exportSheet.ts  (FRAME_W=260 ~11, sprockets ~46, barcode ~69, frame numbers)

Commit on main and verify in the app.
```

### Session H — AI erase quality
Independent. No hot-file overlap.

```
OpenEnlarge/filmrev (SvelteKit + Rust/Tauri). The AI erase / dust-removal tool gives weak
results compared to Photoshop. Investigate inpainting quality: model, mask feathering, patch
size, blending at edges. Propose and implement concrete improvements.

Files:
- src/lib/develop/EraserPanel.svelte
- src/lib/develop/dust.ts
- src-tauri/src/autodust/   (model loading + inference)
- src-tauri/src/commands.rs (dust::apply ~1009, dust::apply_ir ~1022)

Commit on main and verify in the app.
```

---

## Wave 2 — touches the same hot files / render path (run after A is merged)

> Start these in **fresh sessions** that read the post-Session-A code. They don't need A's
> chat history — just its committed changes.

### Session D+F — Develop keyboard overhaul + custom hotkeys + eyedropper stability
SOLE owner of `Develop.svelte` this wave.

```
OpenEnlarge/filmrev (SvelteKit + Rust/Tauri). Develop-view input fixes, in one session because
they all edit src/lib/tabs/Develop.svelte:

A. Keyboard shortcuts don't work in the Develop view at all. Fix focus/handler wiring.
B. Ctrl+C / Ctrl+V (copy/paste develop settings) are dead immediately after an adjustment —
   they only work after you click the image or zoom. Fix the focus issue.
C. Implement the agreed shortcut scheme (modifier/letter + arrow keys), replacing the current
   Q/E·A/D·Z/C nudges (Develop.svelte ~211–286):
     色温/temp = 1 + ←/→      色调/tint = 2 + ←/→
     曝光/exposure = q + ←/→  对比度/contrast = w + ←/→
     高光/shadow = a/s + ←/→  白色/黑色 = z/x + ←/→
     Ctrl+↑ flip vertical, Ctrl+↓ flip horizontal,
     Ctrl+←/→ rotate (also keep Ctrl+[ / Ctrl+] LR-style rotate)
   Then add a user-customizable hotkey settings UI.
D. Eyedropper gray-point WB is unstable: the sample patch is too small (P=0.02) so film grain
   produces extreme/offset params. Widen the sample window and use a robust statistic
   (trimmed mean / median) instead of a single pixel.

Files: src/lib/tabs/Develop.svelte (onKey ~245, adjustKey ~211, onPointPick ~376),
src/lib/keymap/hotkeys.ts, src/lib/develop/copySettings.ts, src/lib/develop/colorPick.ts,
src-tauri/src/commands.rs (gray_point_wb ~1615). Commit on main and verify in the app.
```

### Session E — Basic panel: Auto-WB button + density slider
SOLE owner of `Basic.svelte` this wave.

```
OpenEnlarge/filmrev (SvelteKit + Rust/Tauri). Two additions to src/lib/develop/Basic.svelte:

1. The "white point" icon is confused with the usual auto-WB icon. Add a Lightroom-style
   one-click Auto WB button (and clarify/replace the white-point icon). The backend
   `as_shot_wb()` already exists at src-tauri/src/commands.rs:1540 — wire it up.
2. Add a brightness/density slider (log curve — behaves like density) positioned BELOW
   exposure and ABOVE contrast. New param in the params store + apply in commands.rs.

Files: src/lib/develop/Basic.svelte, the params store, src-tauri/src/commands.rs.
Commit on main and verify in the app.
```

### Session C — Roll-adjust performance
Shares `commands.rs` render path with Session A.

```
Use the systematic-debugging skill. OpenEnlarge/filmrev (SvelteKit + Rust/Tauri).
On the roll look / adjustments page, each adjustment takes ~5 seconds to render — not
responsive. Profile the roll-level render path and add debounce + caching so adjustments
feel live.

Files: src/lib/roll/Roll.svelte, src/lib/roll/RollAdjust.svelte,
src-tauri/src/commands.rs (render path ~908). Commit on main and verify in the app.
```

---

## Which sessions to keep alive

| Session | Keep after its wave? | Why |
|---|---|---|
| **A** (keystone) | **KEEP until Wave 2 is green** | Wave 2's D/F, E, C all touch the render path & hot files A just changed. If they hit a preview/render regression, A has the context to fix it fast. Close once C/D/E verify clean. |
| B, G, H | Close after merge | Self-contained, nothing downstream depends on them. |
| D+F, E, C | Close after merge | End of the chain; no later wave builds on them. |

**Net:** the only session worth keeping across waves is **A**. Everything else can be closed
once its work is committed and verified.
