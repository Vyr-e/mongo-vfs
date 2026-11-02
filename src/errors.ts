/** Agent-facing failure. Message is `code: path: hint`. */
export class VfsError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, hint: string) {
    super(`${code}: ${path}: ${hint}`);
    this.name = "VfsError";
    this.code = code;
    this.path = path;
  }
}

export function errno(code: string, syscall: string, path: string): Error {
  return new Error(`${code}: no such file or directory, ${syscall} '${path}'`.replace(
    "no such file or directory, ",
    code === "ENOENT" ? "no such file or directory, " : "",
  ));
}

export function fsErr(code: "ENOENT" | "EEXIST" | "EISDIR" | "ENOTDIR" | "ENOTEMPTY" | "EINVAL" | "ELOOP" | "EPERM" | "EACCES", syscall: string, path: string, hint?: string): Error {
  if (code === "ENOENT") return new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`);
  if (code === "EEXIST") return new Error(`EEXIST: file already exists, ${syscall} '${path}'`);
  if (code === "EISDIR") return new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`);
  if (code === "ENOTDIR") return new Error(`ENOTDIR: not a directory, ${syscall} '${path}'`);
  if (code === "ENOTEMPTY") return new Error(`ENOTEMPTY: directory not empty, ${syscall} '${path}'`);
  if (code === "ELOOP") return new Error(`ELOOP: too many symbolic links, ${syscall} '${path}'`);
  if (code === "EPERM") return new Error(`EPERM: operation not permitted, ${syscall} '${path}'`);
  if (code === "EACCES") return new Error(`EACCES: permission denied, ${syscall} '${path}'`);
  return new Error(`EINVAL: ${hint ?? "invalid argument"}, ${syscall} '${path}'`);
}
