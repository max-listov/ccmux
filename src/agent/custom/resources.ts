import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentHarnessFileResources } from 'stitchkit/agent-runtime/harness';
import { readPrivate } from '../../attachments/files.ts';
import { policySha256 } from '../../policy/sources.ts';
import { privateRuntimeDirectory } from '../codex/ownedPaths.ts';
import type { PreparedCustomHost } from './host.ts';

/** Materialize only already-verified immutable source bytes into this registration's private root.
 * Discovery and lazy tool reads still belong to the published harness, not a second resource API. */
export async function prepareCustomResources(root: string, host: PreparedCustomHost) {
  privateRuntimeDirectory(root);
  if (host.resources.length === 0)
    return { load: async () => ({ resources: [], diagnostics: [] }), runtimeTools: [] };
  const roots = [];
  for (const source of host.resources) {
    const directory = join(root, source.id);
    privateRuntimeDirectory(directory);
    const path = join(directory, source.kind === 'skill' ? 'SKILL.md' : `${source.id}.md`);
    try {
      await writeFile(path, source.body, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (policySha256(readPrivate(path, 256 * 1024)) !== source.sha256)
      throw new Error('Retained Custom resource differs from its accepted digest');
    roots.push({ id: source.id, kind: source.kind, path: directory });
  }
  const resources = createAgentHarnessFileResources({
    roots,
    limits: { maxTotalBytes: 256 * 1024, maxFiles: 32 },
  });
  const loaded = await resources.load();
  if (
    loaded.diagnostics.some(({ severity }) => severity === 'error') ||
    loaded.resources.length !== host.resources.length
  )
    throw new Error('Custom resource discovery did not preserve the accepted sources');
  return resources;
}
