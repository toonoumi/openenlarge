import { get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { images, activeId, module, selectedFolder } from "../store";
import { tetherAutoAdvance, tetherLast, tetherWatching, tetherDir } from "./store";

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

let unlisten: UnlistenFn | null = null;

/** Begin a tether session on `dir`. The watched folder becomes the active roll. */
export async function startTether(dir: string): Promise<void> {
  await api.tetherStart(dir);
  try {
    if (!unlisten) {
      // Registered once per process. The backend replaces its watcher on each
      // start but always emits the same event, so one listener serves every
      // session. In-flight events from a prior watcher route to processNewFile by
      // their own path (not tetherDir), so a folder switch can't misattribute them.
      unlisten = await listen<{ path: string }>("tether://new-file", (e) => {
        void processNewFile(e.payload.path);
      });
    }
  } catch (e) {
    // Listener failed to register — don't leave the backend watching with no
    // consumer. Stop the backend and surface the error to the caller.
    await api.tetherStop();
    throw e;
  }
  selectedFolder.set(dir);
  tetherDir.set(dir);
  tetherWatching.set(true);
}

/** End the tether session. */
export async function stopTether(): Promise<void> {
  await api.tetherStop();
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  tetherWatching.set(false);
}
