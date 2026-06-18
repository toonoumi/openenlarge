# Resident-memory LRU — design (Spec 2)

Status: approved design, ready for implementation.
Date: 2026-06-17.

## Problem

`Session.images: HashMap<id, CachedImage>` holds a `developed: Option<Developed>`
per image — the decoded proxy working buffer (≤2560 long edge, ~17 MB) + thumb +
base/d_max. Once an image is developed/opened, its `developed` stays resident forever;
opening many images grows memory without bound. (Spec 1 already bounded the other
heavy fields: `zoom_src` is single-slot, `pending_export` is keyed and cleared on
finish.)

## Goal

Bound resident decoded memory with an LRU: keep the N most-recently-accessed
`developed` buffers resident, evict the rest. Re-hydration is automatic — the existing
`ensure_resident` reads the `.oecache` sidecar when `developed` is `None`.

## Non-goals

- Byte-accurate budgeting (proxies are uniform ≤17 MB now that Quality is gone, so a
  count cap is an adequate proxy for bytes).
- A user-facing setting (the cap is a compile-time const).
- Evicting the lightweight `CachedImage` record (path/metadata/thumbnail) — that stays
  for the grid/catalog; only the heavy `developed` (+ paired `autodust_prob`) is evicted.

## Design

### Access tracking
- `Session.access_tick: AtomicU64` (new). Monotonic; `fetch_add(1, Relaxed)` yields the
  next tick. Higher = more recently used.
- `CachedImage.last_access: u64` (new field, default 0). Stamped with the next tick on
  every touch of the image.

### Touch point
- `Session::touch(&self, id: &str)` — stamp `images[id].last_access = next_tick()`.
- Called from `ensure_resident` on **every** call, including the already-resident fast
  path (so the LRU reflects real render/upload usage), and after `develop_heavy` inserts
  a fresh `developed`.

### Cap + eviction
- `const MAX_RESIDENT_DEVELOPED: usize = 24;` (~400 MB worst case at 17 MB/proxy).
- Eviction runs **only when the resident set grows** — i.e. right after a new
  `developed` is inserted (the `ensure_resident` cache-load path and `develop_heavy`).
  Renders/uploads that hit an already-resident image only `touch` (count unchanged, no
  scan).
- `Session::evict_lru(&self, keep_id: &str) -> Vec<String>`:
  1. Lock `images`. Collect `(id, last_access)` for entries with `developed.is_some()`.
  2. If count ≤ `MAX_RESIDENT_DEVELOPED`, return empty.
  3. Sort ascending by `last_access`; take the `count - cap` oldest, excluding `keep_id`
     (belt-and-suspenders — `keep_id` was just stamped newest, so it's never oldest).
  4. Set `developed = None` on each; collect their ids. Release the `images` lock.
  5. Lock `autodust_prob`; remove those ids. (Sequential locks, never nested → no
     deadlock; a rare race just drops a regenerable prob map.)
  6. Return the evicted ids.

### Re-hydration
Unchanged: `ensure_resident` reads `.oecache` and re-inserts `developed` when it's
`None`. The active image renders continuously → newest tick → never evicted.

## Files
- `session.rs`: `access_tick: AtomicU64` field; `CachedImage.last_access: u64`;
  `MAX_RESIDENT_DEVELOPED` const; `next_tick`, `touch`, `evict_lru` methods. Add
  `use std::sync::atomic::{AtomicU64, Ordering}`.
- `commands.rs`: `session.touch(&id)` in `ensure_resident` (resident fast-path + after
  cache-load insert) and after the `develop_heavy` insert; `session.evict_lru(&id)` after
  each insert (it drops the evicted `developed` **and** their `autodust_prob` internally —
  the returned Vec is informational).

## Edge cases
- **In-flight render of an evicted image:** render clones `working` out under the lock
  before processing, so an eviction after that clone is harmless; the next render
  re-hydrates.
- **`keep_id`:** the just-inserted/just-touched id is newest → never selected; the
  explicit exclusion guards the boundary.
- **`AtomicU64` default:** `Session` derives `Default`; `AtomicU64: Default` (0). `0` is a
  valid "never touched" tick (any touched entry outranks it).

## Testing
- Unit-test `evict_lru` without files: build a `Session::default()`, insert
  `MAX_RESIDENT_DEVELOPED + 3` `CachedImage`s each with `developed = Some(dummy)` and
  ascending `last_access`, call `evict_lru("newest_id")`, assert: the 3 oldest have
  `developed == None`, the rest (incl. `keep_id`) are `Some`, resident count == cap, and
  the returned Vec lists the 3 evicted ids.
- Existing tests stay green (`Session::default()` unaffected by the new fields).
