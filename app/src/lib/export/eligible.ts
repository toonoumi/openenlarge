import { derived } from "svelte/store";
import { images, folderImages } from "../store";

/** Images that have been developed — the only ones eligible for export. */
export const developedImages = derived(images, ($i) => $i.filter((x) => x.developed));

/** Developed images within the current folder scope (the filmstrip row). Export
 * scopes to these so the dialog only offers what's shown in the bottom thumbnail row. */
export const developedFolderImages = derived(folderImages, ($i) => $i.filter((x) => x.developed));

/** True when at least one image is developed. */
export const hasDeveloped = derived(images, ($i) => $i.some((x) => x.developed));
