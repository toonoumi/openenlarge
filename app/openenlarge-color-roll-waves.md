# OpenEnlarge — Color & Roll-Workflow Waves (parallel dispatch plan)

Feedback from the OpenEnlarge group chat (凤英同志自传, testing 乐凯 C400 narrow-band copy on a
GFX). Each **Session** below is a separate Claude Code session — copy the prompt block into a
fresh session. Run a whole wave in parallel; **do not start Wave 2 until Session C is merged**
(Wave 2 edits the same roll hot files).

**Hot files (single-owner only):** `src/lib/develop/Basic.svelte` — touched by Session B
(saturation/WB UI) and Session D (the "apply to whole roll" button), so D is sequenced into
Wave 2 *after B merges*. `src/lib/tabs/Roll.svelte` — shared by the contact-sheet session (C)
and the whole-roll-sync session (D), also split across waves. `src-tauri/src/commands.rs` is
large — Sessions A and B edit *different* functions in it (exposure/WB resolve vs.
saturation/color rendering), so they don't conflict.

**Shared color path:** Sessions A and B both live in the Cineon engine's color stage
(`build_params` / `resolve_params` / `wb_from_params` ~191–268, plus `film_core` finish). A
owns the **exposure↔WB coupling**; B owns the **saturation/look**. Decide the root cause in A
*before* B changes saturation, so B isn't compensating for an exposure-driven WB drift.

---

## Wave 1 — independent lanes (run all 3 in parallel)

### Session A — Exposure ±5 shifts color temperature  ⭐ KEYSTONE (color path)
Owns: exposure→WB resolve path in `commands.rs` + `film_core` finish. No frontend hot files.

```
Use the systematic-debugging skill. OpenEnlarge/filmrev (SvelteKit frontend in app/src/lib,
Rust backend in app/src-tauri/src).

Reported by a tester on 乐凯 C400 (narrow-band spectral copy on a GFX): on the SAME image,
nudging exposure by ±5 visibly shifts the color temperature. They're unsure if it's an
algorithm bias or a genuine film effect (halation / uneven emulsion-layer response).

First DECIDE which it is — don't guess:
1. Render the same frame at exposure −5 / 0 / +5 with temp & tint pinned, and measure the
   neutral patch (or gray-world average) CCT at each. Quantify the drift in Kelvin.
2. Trace the math. exposure becomes print_exposure = 2^exposure (commands.rs:198), then WB is
   applied via wb_from_params(temp, tint) (commands.rs:256, resolve_params ~260). Check the
   ORDER: if exposure scales linear RGB and the filmic/print curve is applied per-channel
   AFTER, a global exposure change moves each channel a different amount along a non-linear
   curve → apparent temp shift. That's the likely algorithmic culprit.

Deliverable: either (a) decouple exposure from perceived WB so temp is stable across the
exposure range (exposure should change brightness, not hue), OR (b) if the coupling is
physically correct film behavior, document the measurement and confirm it's intended — and
add a short note in the UI/help so testers know it's expected. Write up the Kelvin-drift
numbers before/after.

Key files:
- src-tauri/src/commands.rs (build_params ~191, resolve_params ~260, wb_from_params ~256,
  print_exposure ~198)
- src-tauri/src/finish.rs / film_core finish (the per-channel filmic/print curve)
- src/lib/develop/Basic.svelte (exposure + temp/tint sliders, for the repro)

Commit on main when done and verify in the running app.
```

### Session B — CMY color-head "look" + saturation feels low
Independent of A's *functions* but same `commands.rs` file — coordinate; this is the look/R&D lane.

```
Use the brainstorming skill first, then implement. OpenEnlarge/filmrev (SvelteKit + Rust/Tauri).

Tester compared three renders of the same negative — left→right: optical Color head (CMY
dichroic enlarger), digital camera, and OE. Two findings:
1. The temp/tint control doesn't feel EQUIVALENT to a CMY subtractive mixing color head —
   they can't dial in the color-head "feeling" no matter how they adjust.
2. Saturation reads as too low; bumping the saturation slider helps but quickly looks fake.

Investigate the color-rendering path and propose concrete improvements:
- Is our WB a simple per-channel gain (wb_from_kelvin) vs. a CMY subtractive model? Consider a
  CMY/dichroic-style mixing option or a tone-axis (temp/tint) that behaves subtractively like
  an enlarger head, so the color-head look becomes reachable.
- Why does saturation collapse — is the filmic/print curve desaturating highlights/shadows?
  Look at a perceptual / film-like saturation (e.g. saturate in a film-density or HSL space,
  protect skin/neutrals) so pushing it stays believable instead of going neon.

Files:
- src-tauri/src/commands.rs (wb_from_params ~256, resolve_params ~260)
- src-tauri/src/finish.rs / film_core finish (print curve + any saturation)
- src/lib/develop/Basic.svelte, src/lib/develop/ColorMixer.svelte,
  src/lib/develop/ColorGrading.svelte (saturation + temp/tint UI)

Deliver a short before/after with the tester's comparison frames. Commit on main and verify
in the app.
```

### Session C — Contact sheet: mixed portrait/landscape pushes row height  ⭐ KEYSTONE (roll)
SOLE owner of `Roll.svelte` this wave (Wave 2's sync session also needs it).

```
OpenEnlarge/filmrev (SvelteKit + Rust/Tauri). In the Develop / roll contact sheet, mixing
landscape and portrait frames makes the row get pushed taller (横竖混排会被顶高) — a portrait
crop inflates the whole row height and breaks the grid.

Agreed fix (Lightroom logic): a frame that's been cropped/rotated to portrait should still
occupy a LANDSCAPE tile in the contact sheet — i.e. the sheet tiles are a fixed orientation/
aspect and the image fits inside its tile (letterboxed/centered) regardless of the frame's own
orientation. Match Lightroom's grid behavior: uniform cells, content fit inside, no row
height jumping.

Files:
- src/lib/roll/contactSheet.ts (SheetLayout / tile sizing ~2–20)
- src/lib/tabs/Roll.svelte (grid render)
- src/lib/roll/FramePreview.svelte (per-tile fit)
- src/lib/roll/exportSheet.ts (keep the EXPORTED sheet consistent with the on-screen grid)

Deliver uniform-height rows with portrait frames fit inside landscape tiles. Commit on main
and verify in the app.
```

---

## Wave 2 — touches `Basic.svelte` + roll hot files (run after B AND C are merged)

> Start in a **fresh session** that reads the post-Session-B/C code. D edits `Basic.svelte`
> (which B touched) and `Roll.svelte` (which C touched), so let both land first.

### Session D — LR-style param-select dialog, reused for paste + "apply to whole roll"
SOLE owner of `ConfirmApplySettings.svelte` + the new `Basic.svelte` button this wave.

Design (agreed with the user — **one shared dialog, two entry points**):
- We already have an "apply settings to N images" confirm popup that fires on **paste** when more
  than one image is targeted (`ConfirmApplySettings.svelte`, opened via the `applySettingsTarget`
  store, rendered at `src/routes/+page.svelte:177`). **Convert it into a Lightroom-style window
  with per-parameter-group checkboxes** so the user picks which settings move over. On confirm,
  only the selected groups are applied (not the whole clipboard).
- Add a new **"Apply to whole roll"** button in `Basic.svelte`, positioned **below the film-base /
  film-edge color section and above the White Balance section** (between `Basic.svelte:316` and the
  `<!-- White Balance -->` at `:320`). Tapping it opens the **same** dialog — but the title/wording
  says "apply to the whole roll" — and applies the active frame's selected settings to every frame
  in the roll.

```
OpenEnlarge/filmrev (SvelteKit + Rust/Tauri). Build a single Lightroom-style "select which
settings to apply" dialog and reuse it in two places. Today copying settings one frame at a time
is slow and develop adjustments often need the same change across the whole roll.

1. Convert the existing apply-on-paste confirm popup into an LR-style param picker:
   - src/lib/overlay/ConfirmApplySettings.svelte is shown on paste to >1 target (opened via the
     applySettingsTarget store; rendered at src/routes/+page.svelte:177-180, which calls
     applyClipboardTo(ids) on confirm).
   - Replace the plain count-confirm with grouped checkboxes (Tone/Color, Crop, Film base,
     Exposure, White point — mirror the groupings that already exist in src/lib/roll/apply.ts:
     toneColorOf ~15, applyCropToAll ~48, applyBaseToAll ~60, applyExposureToAll ~70,
     applyWhitePointToAll ~82). Emit the SELECTED groups on confirm.
   - Update copySettings.ts (applyClipboardTo ~52) so it merges only the selected fields onto
     each target instead of the whole clipboard.

2. Add an "Apply to whole roll" button in src/lib/develop/Basic.svelte, placed between the
   film-base section (ends ~line 316) and the "<!-- White Balance -->" block (~line 320).
   Clicking it opens the SAME dialog (re-used component) with whole-roll wording, then applies the
   active frame's selected settings to every frame in the current roll (build the id list from the
   roll, reuse the apply.ts *ToAll helpers / applyClipboardTo with the active params as source).

Make the dialog component generic over its title/copy and its target-id list so both entry points
share it. Add i18n keys via i18n-strings.csv + scripts/gen-i18n.py (do NOT hand-edit dict.ts).

Files:
- src/lib/overlay/ConfirmApplySettings.svelte (param-group checkboxes + generic title)
- src/routes/+page.svelte (paste entry, ~177)
- src/lib/develop/copySettings.ts (applyClipboardTo merges only selected groups)
- src/lib/develop/Basic.svelte (new "apply to whole roll" button between base & WB sections)
- src/lib/roll/apply.ts (reuse the per-group helpers / group definitions)

Commit on main and verify both entry points in the app.
```

---

## Which sessions to keep alive

| Session | Keep after its wave? | Why |
|---|---|---|
| **A** (color keystone) | **KEEP until B is green** | B's saturation/look work sits on top of A's exposure↔WB decision. If B sees a residual hue drift, A has the context to fix it. Close once B verifies clean. |
| **C** (roll keystone) | **KEEP until D is green** | D reuses the roll grid/apply path C just touched. Close once D verifies clean. |
| B, D | Close after merge | End of their chains; nothing downstream depends on them. |

**Net:** keep **A** across the color lane and **C** across the roll lane; everything else closes
once committed and verified.
