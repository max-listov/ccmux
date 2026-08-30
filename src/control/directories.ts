import { lstat, opendir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "stitchkit";
import { z } from "zod";
import { HOME } from "../env.ts";
import { log } from "../util/log.ts";
import { ControlDirectoryReadSchema, ControlDirectoryResultSchema, type ControlDirectoryResult } from "./directorySchema.ts";
const CursorSchema = z.object({ path: z.string(), version: z.string(), after: z.string(), hidden: z.boolean() }).strict();
const version = (stat: Awaited<ReturnType<typeof lstat>>): string => createHash("sha256")
  .update([stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs].join(":")).digest("hex");

async function directoryStat(path: string) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new AppError("SYMLINK_REFUSED", "Directory symlinks are not followed", 409);
    if (!stat.isDirectory()) throw new AppError("NOT_A_DIRECTORY", "Requested entry is not a directory", 400);
  }
  return lstat(path);
}

/** Names-only, versioned directory pages. Changed directories explicitly invalidate pagination. */
export async function readControlDirectory(input: z.output<typeof ControlDirectoryReadSchema>,
  signal: AbortSignal): Promise<ControlDirectoryResult> {
  const path = resolve(input.path ?? HOME);
  try {
    signal.throwIfAborted();
    const stamp = version(await directoryStat(path));
    let after = "";
    if (input.cursor !== null) {
      let cursor: z.infer<typeof CursorSchema>;
      try { cursor = CursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))); }
      catch { throw new AppError("INVALID_CURSOR", "Directory cursor is invalid", 400); }
      if (cursor.path !== path || cursor.hidden !== input.includeHidden || cursor.version !== stamp)
        throw new AppError("STALE_CURSOR", "Directory changed; restart listing", 409);
      after = cursor.after;
    }
    const entries: ControlDirectoryResult["entries"] = [];
    let scanned = 0;
    const directory = await opendir(path);
    for await (const item of directory) {
      signal.throwIfAborted();
      if (++scanned > 20_000) throw new AppError("DIRECTORY_TOO_LARGE", "Directory exceeds listing budget", 413);
      if ((!input.includeHidden && item.name.startsWith(".")) || item.name <= after) continue;
      entries.push({ name: item.name, path: join(path, item.name),
        kind: item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "dir" : item.isFile() ? "file" : "other" });
    }
    if (version(await directoryStat(path)) !== stamp)
      throw new AppError("STALE_CURSOR", "Directory changed; restart listing", 409);
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const page: ControlDirectoryResult["entries"] = [];
    let bytes = 0;
    for (const item of entries.slice(0, input.limit)) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 240 * 1024) break;
      page.push(item);
    }
    const last = page.at(-1);
    return ControlDirectoryResultSchema.parse({ path, parent: dirname(path) === path ? null : dirname(path), entries: page,
      nextCursor: last !== undefined && page.length < entries.length
        ? Buffer.from(JSON.stringify({ path, version: stamp, after: last.name, hidden: input.includeHidden })).toString("base64url") : null });
  } catch (error) {
    if (error instanceof AppError || signal.aborted) throw error;
    log.error({ msg: "directory listing failed", path, reason: String(error) });
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT") throw new AppError("NOT_FOUND", "Directory was not found", 404);
    if (code === "ENOTDIR") throw new AppError("NOT_A_DIRECTORY", "Requested entry is not a directory", 400);
    if (code === "EACCES" || code === "EPERM") throw new AppError("PERMISSION_DENIED", "Directory is not accessible", 403);
    throw new AppError("UNAVAILABLE", "Directory listing is unavailable", 503);
  }
}
