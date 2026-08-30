import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { policyUnavailable } from './errors.ts';
import type { PolicySource } from './schema.ts';

export const MAX_POLICY_SOURCE_BYTES = 64 * 1024;
export const MAX_POLICY_BYTES = 256 * 1024;
export function policySha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function validatePath(policyId: string, roots: readonly string[], path: string): void {
  const root = roots.find((candidate) => contains(candidate, path));
  if (root === undefined) policyUnavailable(policyId, 'source-outside-trust-root');
  if (realpathSync(root) !== root || realpathSync(path) !== path)
    policyUnavailable(policyId, 'non-canonical-or-symlink-source');
  let current = path;
  while (true) {
    const stat = lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.())
    )
      policyUnavailable(policyId, 'untrusted-source-owner-or-permissions');
    if (current !== path && !stat.isDirectory())
      policyUnavailable(policyId, 'invalid-source-parent');
    if (current === root) break;
    current = dirname(current);
  }
}

/** Admission-only bounded read. A pinned digest also covers byte changes during path checks. */
export function readPolicySource(
  policyId: string,
  roots: readonly string[],
  source: PolicySource,
): string {
  let fd: number | undefined;
  try {
    if (resolve(source.path) !== source.path) policyUnavailable(policyId, 'non-canonical-source');
    validatePath(policyId, roots, source.path);
    fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_POLICY_SOURCE_BYTES)
      policyUnavailable(policyId, 'invalid-source-type-or-size');
    const bytes = Buffer.alloc(MAX_POLICY_SOURCE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd);
    const visible = lstatSync(source.path);
    if (
      length !== before.size ||
      length > MAX_POLICY_SOURCE_BYTES ||
      before.ino !== visible.ino ||
      before.dev !== visible.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      realpathSync(source.path) !== source.path
    )
      policyUnavailable(policyId, 'source-changed-during-read');
    const bodyBytes = bytes.subarray(0, length);
    if (policySha256(bodyBytes) !== source.sha256)
      policyUnavailable(policyId, 'source-digest-mismatch');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
    if (body.includes('\0')) policyUnavailable(policyId, 'invalid-source-text');
    return body;
  } catch (error) {
    if (error instanceof Error && error.message === 'Application policy is unavailable')
      throw error;
    return policyUnavailable(policyId, 'source-unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** OpenCode's canonical agent Markdown owns frontmatter; only its system body is compared. */
export function canonicalAgentPrompt(policyId: string, body: string): string {
  const normalized = body.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized.trim();
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) policyUnavailable(policyId, 'invalid-agent-frontmatter');
  return normalized.slice(end + 5).trim();
}
