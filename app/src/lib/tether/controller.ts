import { get } from "svelte/store";
import { api } from "../api";
import { images, activeId, module } from "../store";
import { tetherAutoAdvance, tetherLast } from "./store";

/** Import → develop one freshly-captured file, then (optionally) bring it to the
 * front. Never throws: a bad frame is recorded in `tetherLast` and the session
 * keeps watching. The develop step inherits the folder's base via the existing
 * resolve path, so no base wiring is needed here. */
export async function processNewFile(path: string): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path;
  try {
    const entry = await api.importImage(path);
    const developed = await api.developImage(entry.id);
    images.update((xs) =>
      xs.some((i) => i.id === developed.id)
        ? xs.map((i) => (i.id === developed.id ? developed : i))
        : [...xs, developed],
    );
    if (get(tetherAutoAdvance)) {
      activeId.set(developed.id);
      module.set("develop");
    }
    tetherLast.set({ name, ok: true });
  } catch (e) {
    tetherLast.set({ name, ok: false, error: String(e) });
  }
}
