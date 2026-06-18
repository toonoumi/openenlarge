# User Feedback → Dispatch-Ready Task Breakdown (2026-06)

Source: long-form user feedback on a Pro400H roll (heavily over-exposed). Each task below is
self-contained — hand one to a fresh Claude with the "Files" + "Investigate/Approach" sections
and it has enough to start. Line numbers were accurate at exploration time; re-confirm before editing.

Categories: **BUG** (broken/incorrect), **PERF** (correct but unusably slow), **IMPROVEMENT**
(works but mistuned), **FEATURE** (doesn't exist), **RESEARCH** (open-ended / spike first).

Raw feedback items map to tasks as noted in each "Covers" line so nothing is lost.

---

## BUGS

### B1 — Clipping/overflow warning is inaccurate (samples the wrong pipeline stage)
**Category:** BUG · **Effort:** M · **Covers feedback #3**

> "溢出的计算方式有点过于激进了，到253似乎才会报警… 即使把曝光加到全白，他也不怎么报警。调暗同理。"
> (Clipping calc is too aggressive — only warns at ~253; even pushing exposure until the image
> is visually all-white barely warns. Same when darkening.)

**Root cause (likely):** The warning threshold/stage is mismatched with what's actually clipped on
screen. In `strict=false` mode the high threshold is `1.0` (pure white only); `253/255` only in
strict. More importantly the test happens on the tone-mapped + LUT'd + soft-clipped value, after a
Reinhard highlight rolloff that *never reaches 1.0* — so genuinely blown content rolls off to ~0.99
and never trips the test. The warning should reflect "detail is lost," i.e. test the value that's
being clamped/compressed, not the post-rolloff display value.

**Files:**
- `app/src/lib/viewport/gl/clip.ts` (thresholds; `hi = strict ? 253/255 : 1.0`)
- `app/src/lib/viewport/gl/shaders.ts:178-184` (`applyClip`), soft-clip at engine level
- `crates/film-core/src/engine.rs:124-133` (Reinhard soft-clip — why nothing hits 1.0)
- `app/src/lib/store.ts:156-162` (warning state), `renderer.ts:354-357` (uniforms)

**Decision (locked):** Use **output detail-loss** semantics, not capture-clip. The warning answers
"is this highlight gone or recoverable on the current render," which is a property of the displayed
image — not "did the film record nothing here." Capture-clip would stay silent exactly on the
over-exposed-but-dense Pro400H case (detail is on the negative; the engine compresses it away), i.e.
when the user most needs the warning. This also aligns with I1 (same compression the warning flags is
what exposure should relieve).

**Approach / acceptance:** Flag where detail is being lost at output — e.g. test the value being
clamped/compressed (pre-soft-clip linear, or where soft-clip compression exceeds a threshold), not the
post-rolloff display value that never reaches 1.0. Acceptance: pushing exposure until the frame is
visually white paints the highlight warning across the blown region; crushing to black paints the
shadow warning; a normal frame shows little/none. Verify symmetrically for shadows.

---

### B2 — Color-picker RGB readout is corrupted when the clipping overlay is ON
**Category:** BUG · **Effort:** S–M · **Covers feedback #4**

> "当打开裁切警告之后，会影响取色rgb数值"
> (When the clip warning is on, it changes the picked RGB values.)

**Root cause (confirmed):** The eyedropper does `gl.readPixels` on the WebGL backbuffer
(`preserveDrawingBuffer`), which already has the warning color baked in. Clipped pixels return the
hard-coded overlay color (`vec3(1.0,0.15,0.15)` red / `vec3(0.2,0.45,1.0)` blue) instead of image data.

**Files:**
- `app/src/lib/develop/colorPick.ts:21-34` (`readPixels` from canvas)
- `app/src/lib/viewport/Viewport.svelte:441-459` (RGB readout), `:187-201` (overlay composite)
- `app/src/lib/viewport/gl/shaders.ts:180,182` (overlay colors)

**Approach / acceptance:** Sample image data, not the composited canvas. Options: (a) render the
overlay to a separate FBO so the base color FBO stays clean and read from that; (b) compute the
warning in JS and read the underlying texture; (c) a no-overlay readback pass. Acceptance: picked RGB
is identical whether the clip overlay is on or off, including inside a clipped region.

---

### B3 — "Re-analyze for crop" crushes highlights to flat gray, unrecoverably
**Category:** BUG (behavioral) · **Effort:** M–L · **Covers feedback #15 (and root of #9, #14)**

> "好像和为裁切重新分析功能有关，本来看起来挺正常的底片。一按这个按钮就变得灰白，高光被严重压缩，怎么调都调不回来。"
> (A normal-looking negative turns gray-white after pressing re-analyze; highlights badly compressed,
> can't be recovered by any adjustment.)

**Root cause (confirmed):** `analyze()` → `sample_dmax()` derives `d_max` from the **1st-percentile
transmission inside the crop**. If the crop lacks deep negative density (no true blacks — common when
cropping into sky/highlights, or on an over-exposed frame), the estimated `d_max` drops. In the Cineon
invert `corrected = log_dens / d_max`, a smaller `d_max` inflates `corrected`, pushing midtones/
highlights into the soft-clip region → the whole frame washes out and detail is lost. Mathematically
"correct," behaviorally a trap, and the post-reanalyze `autoWb()` can shift things further.

**Files:**
- `app/src-tauri/src/commands.rs:2036-2066` (`analyze`), `:139-150` Basic.svelte `reanalyze()`/`manualReanalyze()`
- `crates/film-core/src/calibrate.rs:232-259` (`sample_dmax`, 1st-percentile logic)
- `crates/film-core/src/engine.rs:100-138` (how `d_max` drives compression)

**Approach / acceptance:** Make `d_max` robust to crops without blacks — e.g. clamp so re-analysis
can only *raise* confidence not destroy range, sample from the rebate/base region for density floor,
require a minimum density spread before overriding, or warn + offer undo when the new `d_max` would
crush. Acceptance: re-analyzing a normal frame never makes it worse; cropping into an all-highlight
region does not collapse the tone scale; there's always a one-click revert to the pre-reanalyze state.

---

### B4 — Auto white-balance detection is unstable
**Category:** BUG · **Effort:** M · **Covers feedback #10 (relates to #11)**

> "自动白平衡识别有时不太稳定。"
> (Auto WB is sometimes unstable.)

**Root cause (likely):** `gains_to_cct` does a coarse 50 K grid search over 2000–15000 K minimizing an
R/B-ratio error, with no damping/hysteresis. Ambiguous stocks (or over-exposed Pro400H) yield shallow
minima, so small content changes flip the result between neighboring temperatures. Auto WB also runs
off the thumbnail inverted with the *effective* base, so a wobbly base estimate propagates.

**Files:**
- `app/src-tauri/src/commands.rs:1520-1530` (`auto_wb_gains`), `:1541-1554` (gray-point picker)
- `crates/film-core/src/wb.rs:54-73` (`gains_to_cct` grid search)

**Approach / acceptance:** Stabilize the estimator — finer/refined search or analytic solve, robust
gray statistic (trimmed mean), and hysteresis so re-runs on the same image are deterministic.
Acceptance: same image → same temperature across repeated auto-WB; small crop/exposure nudges produce
small WB changes, not jumps.

---

## PERFORMANCE

### P1 — 100% view stutters/freezes while dragging; load only the visible region
**Category:** PERF (architectural) · **Effort:** L · **Covers feedback #8**

> "新的100%查看功能，在加载过程中拖动还是十分卡顿…会死机。放大后加载一整张进缓存…希望能看哪里加在哪里…
> 不要按下的一瞬间就切换为缩略图模式，松开只加载屏幕的那个小区块儿。"
> (100% view stutters/freezes while dragging; it loads the whole image into cache. Want it to load
> only where you look. Don't drop to thumbnail mode the instant you press; on release load only the
> on-screen region.)

**Root cause (confirmed):** Crossing the `hiTier` threshold synchronously triggers
`ensure_zoom_src()`, which calls `decode_any()` on the **entire original file** (RAW/TIFF = 100s ms–s)
on the Tauri async runtime thread, then packs to RGBA16F at up to `MAX_GPU_EDGE=8192`. There is no
debounce on `hiTier` and no region/ROI decode — it's whole-frame-at-a-scale. Hence the block on press
and the freeze while panning.

**Files:**
- `app/src/lib/viewport/Viewport.svelte:97-109` (`hiTier` reactive, no debounce), `:299-337`
  (`uploadWorking`), `:478-481` (`zoomTo100`), `:493-509`/`:609-639` (wheel/tap zoom)
- `app/src-tauri/src/commands.rs:829-843` (`ensure_zoom_src` full decode), `:1683-1733`
  (`working_info`/`working_pixels`)
- `app/src-tauri/src/session.rs:251` (single-slot `zoom_src`), `:282-300` (`evict_lru`)
- `app/src/lib/api.ts:94-104`, `app/src/lib/viewport/view.ts:6-31` (`ViewSpec` already carries a
  `crop` ROI — reusable hook for tiled loading)

**Approach / acceptance:** Two-phase. (1) Quick win: debounce/defer the hires request until the
gesture settles (drag/zoom release), keep showing the current proxy meanwhile instead of dropping to
thumbnail, and move the full decode fully off the UI thread. (2) Real fix: viewport-region (tiled)
loading — decode/pack only the visible crop (the `ViewSpec.crop` plumbing already exists) so cost is
bounded by screen size, not image size. Acceptance: pressing/holding at 100% never freezes the UI;
panning streams in the region under the viewport; no full-image decode when only a corner is viewed.

---

## IMPROVEMENTS

### I1 — Exposure isn't perceptually linear; can't recover over-exposed-negative highlights
**Category:** IMPROVEMENT (core) · **Effort:** L · **Covers feedback #5, #9, #16**

> "曝光功能好像并不是很好用…降低曝光高光的细节并不会被还原出来被拉开，而是继续保持扁平，然后变得很灰。有点儿类似于亮度滑块。"
> "对于过度曝光的底片，高光会被压的非常的平…都难以把它压回这些细节。" (Pro400H, over-exposed; in C1 they
> add exposure before inverting.)
> (Exposure feels unusable — lowering it doesn't pull highlight detail back, it stays flat and goes
> gray, like a brightness slider. Over-exposed negatives flatten highlights that nothing recovers.)

**Root cause:** Exposure is applied as a **linear gain** (`2^EV`) post-inversion but **before** the
Reinhard soft-clip. Once highlights are inside the rolloff, reducing exposure scales the already-
compressed values down (dimmer + grayer) instead of un-compressing them — exactly the "brightness
slider" feel. Heavily over-exposed negatives put more of the scene into that compressed region, so
there's little linear headroom left to redistribute.

**Files:**
- `app/src-tauri/src/commands.rs:187-198` (`build_params`, `print_exposure = 2^exposure`)
- `app/src/lib/viewport/gl/shaders.ts:209-316` (INVERT_FRAG `tone()`), `crates/film-core/src/engine.rs:100-138`
- `app/src/lib/develop/Basic.svelte:255` (slider)

**Approach / acceptance:** Make exposure operate where it spreads highlights — e.g. apply it in
density/log space (pre-print scaling, equivalent to enlarger exposure time) and/or before the soft-
clip headroom is consumed, so lowering exposure genuinely reopens highlight separation. Consider a
pre-invert headroom/"negative exposure" control mirroring the user's Capture One flow (add exposure
to the negative, then invert). **Coordinate with B3** — both are about how density range governs
highlight compression; ideally one engine change serves both. Acceptance: on the user's over-exposed
Pro400H, reducing exposure visibly re-separates blown highlights rather than graying them; exposure
feels like an EV control, not a brightness slider.

---

### I2 — WB temp/tint too sensitive; show relative (±) not absolute K; reduce range/banding
**Category:** IMPROVEMENT · **Effort:** M · **Covers feedback #11**

> "白平衡，色温还是过于灵敏了，鼠标精度都不够…胶片不需要这么大的调整范围…算法也不支持这么大会断层的…
> 提供绝对值意义不大，不如直接给一个正负的相对值。"
> (Temp is too sensitive, mouse precision insufficient; film doesn't need such a huge range; the
> algorithm bands across big moves; absolute values aren't useful — give relative ±.)

**Current state:** Temp 2000–50000 K on a reciprocal/mired track (perceptually correct but huge);
tint −150..+150 mapped to ±50% green in 150 discrete steps (banding risk); temp displays absolute K.
Shift-drag fine mode already exists (`scrubValue.ts`, 8× slow) but range + absolute display dominate.

**Files:**
- `app/src/lib/develop/Basic.svelte:248-251` (ranges/format), `app/src/lib/develop/sliderScale.ts`
  (reciprocal), `app/src/lib/develop/gradients.ts:12-26` (`kelvin`, `signed` formatters)
- `crates/film-core/src/wb.rs:37-74` (gains), `app/src-tauri/src/commands.rs:243-245`
- `app/src/lib/actions/scrubValue.ts` (precision drag, per-slider `pxPerStep`/`fineFactor`)

**Approach / acceptance:** (a) Switch temp display to relative ± from the as-shot/neutral baseline
(`format={(v)=>signed(v-baseline)}`); (b) tighten the practical range and/or reduce per-pixel
sensitivity for film (tune `pxPerStep`/`scrubStep`); (c) smooth tint stepping to kill banding (finer
internal resolution / continuous mapping). Acceptance: a normal correction spans a comfortable portion
of the track; no visible banding across a tint sweep; readout shows e.g. "−300 / +400" relative.
**Note:** pairs naturally with F3 (hotkey nudges) and B4 (auto-WB baseline).

---

### I3 — Texture slider is too weak at both extremes
**Category:** IMPROVEMENT · **Effort:** S–M · **Covers feedback #7**

> "新的纹理功能感觉对比其他滑块儿功能强度不算特别强。没有特别锐利或者特别模糊。"
> (Texture feels weaker than other sliders — not very sharp or very blurry at the ends.)

**Root cause (confirmed):** Unsharp mask with a **1-px, 3-tap** Gaussian and gain capped at
`1.5×slider`. Tiny radius = subtle high-pass; at fit-to-window it runs on proxy-resolution pixels so
the spatial span is nearly invisible.

**Files:**
- `app/src/lib/viewport/gl/shaders.ts:186-202` (GPU USM, `k=1.5*u_texture`, 3×3)
- `crates/film-core/src/finish.rs:467-521` (CPU USM, `USM_GAIN=1.5`)
- `app/src/lib/viewport/gl/uniforms.ts:10-21` (`texture/100` scaling)

**Approach / acceptance:** Increase blur radius (≈5–10 px, scaled to image resolution not proxel),
raise the gain ceiling, and ensure the effect is evaluated at a resolution where it's visible.
Acceptance: at +100 the image is clearly sharper / has more local contrast; at −100 clearly softer;
parity between CPU export and GPU preview.

---

### I4 — Tone-curve reference ("background") curve shifts with the grading curve
**Category:** IMPROVEMENT (UX) · **Effort:** S–M · **Covers feedback #6**

> "色调曲线的背景曲线会根据当前调色曲线发生变化…我没有办法精确的控制我想裁切到什么位置。不过作为一种特性也不是不行。"
> (The tone curve's background curve changes with the current grading curve, so I can't precisely
> control where I clip. As a feature it's okay though.)

**Findings:** The editor draws a static diagonal identity line plus a **live histogram** that updates
as the preview changes. The user likely reads the moving histogram as a moving "reference curve,"
losing a fixed anchor for where input maps to output.

**Files:**
- `app/src/lib/develop/CurveEditor.svelte:204` (diagonal), `:206-208` (live histogram)
- `app/src/lib/develop/curve.ts:18-57` (spline), `app/src/lib/develop/finish.ts:28-58` (LUT/regions)

**Approach / acceptance:** Confirm intent with the user, then give a stable reference: option to
freeze/toggle the background histogram, show fixed gridlines / input-value tics, and/or a numeric
readout of the hovered point's in→out so clip positions are precise. Acceptance: the user can place a
point at a known input value and see it stay put regardless of the current curve shape.

---

## FEATURES

### F1 — Apply one image's settings to the whole roll/folder  ·  ⚠️ USER-OWNED, DO NOT DISPATCH
**Category:** FEATURE · **Status:** the user is already implementing this; kept here only so feedback
#2 is accounted for. **Do not assign.** · **Covers feedback #2**

> "之前提到的，选一次然后应用全卷统一的功能我并没有找到。"
> (The previously-discussed "select once, apply uniformly to the whole roll" feature — I couldn't
> find it.)

**Findings:** Copy/paste settings already exists (`Cmd/Ctrl+C`/`V`, `applyClipboardTo(ids)`), folders
model a "roll" (`folderScope.ts`, `folderImages` derived store), and the multi-target confirm dialog
exists. Missing is just a one-click "apply to this folder/roll" entry point. Note copy/paste
deliberately excludes per-image calibration (`base_override`, `d_max_override`) and film stock —
confirm whether "whole roll" should share base too (per memory: base is per-roll).

**Files:**
- `app/src/lib/develop/copySettings.ts:52-75` (`applyClipboardTo`), `ConfirmApplySettings.svelte`
- `app/src/lib/library/folderScope.ts`, `app/src/lib/store.ts` (`folderImages`, `editsById`)
- `app/src/lib/tabs/Develop.svelte:192-232` (keydown), `app/src/lib/keymap/hotkeys.ts` (registry)

**Approach / acceptance:** Add "Apply settings to roll/folder" button + hotkey that calls
`applyClipboardTo(folderImages.map(i=>i.id))` (or copies the active image's edits to all), via the
confirm dialog. Decide base/calibration inclusion with the user. Acceptance: adjust one frame → one
click → every frame in the folder gets the same tone/color; per-image base preserved unless opted in.

---

### F2 — Scroll-wheel to resize the film-base sampling selection
**Category:** FEATURE · **Effort:** S · **Covers feedback #1**

> "片基取色非常漂亮、非常好用…或许可以加一个滑动滚轮放大缩小选区范围。"
> (Base color picking is beautiful and useful — maybe add a scroll wheel to grow/shrink the selection
> region.)

**Files:**
- `app/src/lib/develop/BaseView.svelte` (sampling overlay UI), `app/src/lib/develop/Basic.svelte:75-110`
  (`toggleRecalibrate`, `applyBaseThisImage`)
- `app/src-tauri/src/commands.rs:1983-2007` (`sample_base_at` takes a rect)

**Approach / acceptance:** Add a `wheel` handler on the base-sampling overlay that grows/shrinks the
sample rect around the cursor (clamped to sane min/max), then re-samples. Acceptance: scrolling over
the base picker visibly resizes the selection and updates the sampled base; works with existing
recalibrate flow.

---

### F3 — Keyboard adjustment shortcuts with fine-step modifier
**Category:** FEATURE · **Effort:** M · **Covers feedback #12**

> "建议做一套调整颜色、曝光影调的组合键。比如 qe 加减色温，ad 调整色调，zc 调整曝光…按住 ctrl 或 shift 能以
> 1/10 的精度高精度微调。"
> (Add combo keys for color/exposure/tone: Q/E ± temp, A/D tint, Z/C exposure, with Ctrl/Shift = 1/10
> fine-step.)

**Findings:** Global keydown handling lives in `Develop.svelte:onKey`; adjustments are applied via
`params.update(p=>({...p, field: ...}))` then `commitActive()`. No per-parameter nudge hotkeys yet.

**Files:**
- `app/src/lib/tabs/Develop.svelte:192-232` (`onKey`), `app/src/lib/keymap/hotkeys.ts` (registry),
  `KeymapModal.svelte` (help)
- `app/src/lib/develop/Basic.svelte` (param fields), `app/src/lib/store.ts` (`params`, `commitActive`)

**Approach / acceptance:** Add Q/E (temp), A/D (tint), Z/C (exposure) — confirm full mapping with the
user — each nudging the param by a coarse step, or 1/10 step when Ctrl/Shift is held; commit to undo;
respect `formFocused()` so typing in fields isn't hijacked; register in the keymap help. Acceptance:
keys nudge the right sliders by sensible steps, fine modifier = 1/10, shows in the shortcut help, and
doesn't fire while editing text. **Pairs with I2** (sensible step sizes).

---

## RESEARCH

### R1 — Subtractive CMY enlarger ("color-head") grading model
**Category:** RESEARCH / large FEATURE · **Effort:** L (spike first) · **Covers feedback #13, #14**

> "如果通过密度域来计算胶片，是否可以通过类似模拟 cmy 3色混光系统来做调色？别的软件有这种功能…有一部分卷用您的
> 软件效果特别好，有一部分用别家（反转后定义黑白点修正伽马 / 号称模拟 CMY 混光系统）的效果好一些。"
> (Since you compute in the density domain, could grading work like a simulated CMY 3-color light-
> mixing enlarger? Other apps have this. Some rolls look best in your app, some in others — those
> others either set black/white points + fix gamma after inversion, or simulate CMY light mixing.)

**Context:** The engine already works in log-density space (`engine.rs`), which is the natural home for
subtractive CMY filtration (C/M/Y dials = per-channel density offsets before the print transfer —
exactly how an enlarger color head behaves). This is plausibly a strong fit and directly addresses
"some rolls look better elsewhere."

**Files (for grounding):**
- `crates/film-core/src/engine.rs:100-138` (density-space invert + print), `wb.rs` (current WB as gains)
- `app/src/lib/viewport/gl/shaders.ts:246-283` (GL port — must mirror any new math)

**Approach / acceptance (spike):** Prototype C/M/Y density offsets applied before the print transfer
(subtractive), compare against the current gains-based WB on the user's mixed rolls, and report whether
to (a) add CMY dials alongside temp/tint, (b) replace the WB model, or (c) add a "set black/white point
+ gamma after inversion" finishing mode that the competing apps use. Deliver a recommendation + math
before committing to UI. Keep CPU (`engine.rs`) and GL (`shaders.ts`) paths identical.

---

## Suggested dispatch order

1. **Fast wins / clear bugs:** B2, F2, I3, I4 (small, independent, high satisfaction). *(F1 is
   user-owned — excluded.)*
2. **Correctness:** B1, B3, B4 — B1 and B3 touch the clip/soft-clip + d_max math; consider one owner
   to keep the engine coherent. **B3 + I1 share the density-range engine** — sequence or co-own them.
3. **Perf:** P1 phase 1 (debounce/off-thread) standalone; phase 2 (tiled) after.
4. **UX tuning:** I2 + F3 together (ranges + hotkey steps).
5. **Strategy:** R1 spike — informs whether WB/grading gets reworked before polishing I2.

**Cross-task coupling to honor:**
- B1 ↔ B3 ↔ I1: all governed by soft-clip + `d_max`; uncoordinated edits will fight.
- I2 ↔ F3 ↔ B4: WB sensitivity, hotkey steps, auto-WB baseline.
- Every engine math change (`engine.rs`) must be mirrored in `shaders.ts` (GL) — there's a parity test
  at `crates/film-core/src/engine.rs:167-195` to extend.
