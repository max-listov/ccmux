import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentCodingArtifactStore } from 'stitchkit/agent-runtime/coding-tools';
import { z } from 'zod';
import { withDirectoryLock } from '../../config/registryLock.ts';
import { privateRuntimeDirectory } from '../codex/ownedPaths.ts';

export const CUSTOM_ARTIFACT_LIMITS = {
  maxItems: 256,
  maxBytes: 1024 * 1024,
  maxReadBytes: 64 * 1024,
};
const ReadSchema = z
  .object({
    reference: z.uuid(),
    offset: z.int().nonnegative(),
    maxBytes: z.int().positive().max(CUSTOM_ARTIFACT_LIMITS.maxReadBytes),
  })
  .strict();

/** This root belongs to one registration. References are opaque, reads are bounded, and archive
 * retains the files. Quota refusal never silently deletes a referenced history artifact. */
export function customArtifactStore(root: string): AgentCodingArtifactStore {
  privateRuntimeDirectory(root);
  return {
    async write({ data }) {
      if (data.byteLength > CUSTOM_ARTIFACT_LIMITS.maxBytes)
        throw new Error('Custom output exceeds the artifact limit');
      return withDirectoryLock(
        join(root, 'write.lock'),
        async () => {
          const files = await readdir(root);
          if (
            files.filter((file) => z.uuid().safeParse(file).success).length >=
            CUSTOM_ARTIFACT_LIMITS.maxItems
          )
            throw new Error('Custom output artifact quota reached');
          const reference = randomUUID();
          const file = await open(
            join(root, reference),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.writeFile(data);
            await file.sync();
          } finally {
            await file.close();
          }
          return { reference };
        },
        'Custom output artifacts',
      );
    },
    async read(raw) {
      const input = ReadSchema.parse(raw);
      const file = await open(
        join(root, input.reference),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > CUSTOM_ARTIFACT_LIMITS.maxBytes ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error('Custom output artifact is unavailable');
        const data = Buffer.alloc(Math.min(input.maxBytes, Math.max(0, stat.size - input.offset)));
        const { bytesRead } = await file.read(data, 0, data.length, input.offset);
        return { data: data.subarray(0, bytesRead), totalBytes: stat.size };
      } finally {
        await file.close();
      }
    },
  };
}
