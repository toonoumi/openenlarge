/** The normalized real directory an image lives in (its path minus the filename). */
export function imageDir(img: { path: string }): string {
  return img.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
}

/** Is an image directory inside the selected folder? Recursive on parents:
 * selecting a parent captures every descendant. `null` selection = show all.
 * Uses a "/"-boundary so a name prefix (".../ny2026") never captures a longer
 * sibling (".../ny2026-2"). */
export function inFolder(dir: string, selected: string | null): boolean {
  if (selected == null) return true;
  return dir === selected || dir.startsWith(selected + "/");
}

/** The subset of images that live in the selected folder (recursive on parents). */
export function scopeToFolder<T extends { path: string }>(
  images: T[],
  selected: string | null,
): T[] {
  return images.filter((i) => inFolder(imageDir(i), selected));
}
