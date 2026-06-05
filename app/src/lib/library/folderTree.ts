export interface FolderNode {
  name: string;
  fullPath: string;
  children: FolderNode[];
  imageIds: string[];
}

/** Build a macOS-style folder tree from imported image paths. Roots are volumes
 * (/Volumes/X) or "Macintosh HD" for everything else. Each folder lists the ids
 * of images directly inside it. */
export function buildTree(entries: { id: string; path: string }[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  const ensure = (fullPath: string, name: string, parent: FolderNode[]): FolderNode => {
    let n = byPath.get(fullPath);
    if (!n) { n = { name, fullPath, children: [], imageIds: [] }; byPath.set(fullPath, n); parent.push(n); }
    return n;
  };
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, "/").split("/").filter(Boolean);
    parts.pop();
    let rootName: string, rootPath: string, dirParts: string[];
    if (parts[0] === "Volumes" && parts.length >= 2) {
      rootName = parts[1]; rootPath = "/Volumes/" + parts[1]; dirParts = parts.slice(2);
    } else {
      // Real filesystem root, displayed as "Macintosh HD". rootPath "" so children
      // accumulate to real paths ("/Users/…") that match an image's directory.
      rootName = "Macintosh HD"; rootPath = ""; dirParts = parts;
    }
    let node = ensure(rootPath, rootName, roots);
    let acc = rootPath;
    for (const d of dirParts) {
      acc = acc + "/" + d;
      node = ensure(acc, d, node.children);
    }
    node.imageIds.push(e.id);
  }
  return roots;
}

/** Total images in a folder subtree (recursive). */
export function countImages(node: FolderNode): number {
  return node.imageIds.length + node.children.reduce((s, c) => s + countImages(c), 0);
}
