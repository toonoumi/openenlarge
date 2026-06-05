export interface SelState {
  selected: Set<string>;
  anchor: string | null;
}

export interface Mods {
  meta: boolean;  // Ctrl or Cmd
  shift: boolean;
}

export const allSelected = (ids: string[]): SelState => ({
  selected: new Set(ids),
  anchor: ids[ids.length - 1] ?? null,
});

export const noneSelected = (): SelState => ({ selected: new Set(), anchor: null });

export function click(state: SelState, ids: string[], id: string, mods: Mods): SelState {
  if (mods.shift && state.anchor !== null && ids.includes(state.anchor)) {
    const a = ids.indexOf(state.anchor);
    const b = ids.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return { selected: new Set(ids.slice(lo, hi + 1)), anchor: state.anchor };
  }
  if (mods.meta) {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}

export const isAllSelected = (state: SelState, ids: string[]): boolean =>
  ids.length > 0 && ids.every((i) => state.selected.has(i));

export const toggleAll = (state: SelState, ids: string[]): SelState =>
  isAllSelected(state, ids) ? noneSelected() : allSelected(ids);
