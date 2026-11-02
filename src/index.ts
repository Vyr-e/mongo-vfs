export { MongoFs } from "./mongo-fs.js";
export type { MongoFsTarget, MongoFsTargetFactory, OpenOptions } from "./mongo-fs.js";
export { VfsError } from "./errors.js";
export { denySubtrees, normalizePath, resolvePath } from "./path.js";

/**
 * The MongoDB driver reads process.hrtime and performance.now while a command
 * is running, and on Bun it also arms a setTimeout when a read misses the
 * content cache. just-bash treats all three as a sandbox escape unless they are
 * excluded. Without this, writes fail everywhere and cold reads fail on Bun.
 */
export const mongoBashDefense = {
  excludeViolationTypes: ["process_timing", "performance_timing", "setTimeout"] as (
    | "process_timing"
    | "performance_timing"
    | "setTimeout"
  )[],
};
