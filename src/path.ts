/** Virtual paths. `.` and `..` collapse. A path cannot climb above `/`. */

export function normalizePath(input: string): string {
  if (input.includes("\0")) {
    throw new Error(`ENOENT: path contains null byte, open '${input}'`);
  }
  if (!input || input === "/") return "/";
  let path = input;
  if (path.endsWith("/") && path !== "/") path = path.slice(0, -1);
  if (!path.startsWith("/")) path = `/${path}`;
  const resolved: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return `/${resolved.join("/")}` || "/";
}

export function resolvePath(base: string, path: string): string {
  if (path.startsWith("/")) return normalizePath(path);
  const combined = base === "/" ? `/${path}` : `${normalizePath(base)}/${path}`;
  return normalizePath(combined);
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const i = normalized.lastIndexOf("/");
  return i === 0 ? "/" : normalized.slice(0, i);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a deny predicate for MongoFs's `deny` option that blocks each root and
 * everything under it. Roots are normalized, so ".vault" and "/.vault/" both
 * mean /.vault.
 */
export function denySubtrees(roots: string[]): (path: string) => boolean {
  const normalized = roots.map(normalizePath);
  return (path) => normalized.some((root) => path === root || path.startsWith(`${root}/`));
}
