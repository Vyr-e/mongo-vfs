import { basename, dirname } from "./path.js";

export type Kind = "file" | "dir" | "symlink";

export interface Node {
  kind: Kind;
  mode: number;
  mtime: Date;
  size: number;
  rev: number;
  storage: "inline" | "cas";
  target?: string;
}

export class PathTree {
  readonly nodes = new Map<string, Node>();
  readonly children = new Map<string, Set<string>>();

  constructor() {
    const now = new Date();
    this.nodes.set("/", {
      kind: "dir",
      mode: 0o755,
      mtime: now,
      size: 0,
      rev: 0,
      storage: "inline",
    });
    this.children.set("/", new Set());
  }

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  get(path: string): Node | undefined {
    return this.nodes.get(path);
  }

  list(dir: string): string[] {
    return [...(this.children.get(dir) ?? [])].sort();
  }

  allPaths(): string[] {
    return [...this.nodes.keys()];
  }

  add(path: string, node: Node): void {
    if (path === "/") {
      this.nodes.set("/", node);
      return;
    }
    const parent = dirname(path);
    const parentNode = this.nodes.get(parent);
    if (!parentNode || parentNode.kind !== "dir") {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    let kids = this.children.get(parent);
    if (!kids) {
      kids = new Set();
      this.children.set(parent, kids);
    }
    kids.add(basename(path));
    this.nodes.set(path, node);
    if (node.kind === "dir" && !this.children.has(path)) {
      this.children.set(path, new Set());
    }
  }

  removeTree(path: string): string[] {
    const removed: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key === path || key.startsWith(`${path}/`)) removed.push(key);
    }
    for (const key of removed) {
      this.nodes.delete(key);
      this.children.delete(key);
    }
    if (path !== "/") {
      this.children.get(dirname(path))?.delete(basename(path));
    }
    return removed;
  }

  /** Move src and everything under it to dest. Dest must not exist. */
  renameSubtree(src: string, dest: string): void {
    const keys = [...this.nodes.keys()]
      .filter((key) => key === src || key.startsWith(`${src}/`))
      .sort((a, b) => a.length - b.length);
    const moved = keys.map((key) => [key, this.nodes.get(key)!] as const);
    this.removeTree(src);
    for (const [key, node] of moved) {
      this.add(dest + key.slice(src.length), node);
    }
  }
}
