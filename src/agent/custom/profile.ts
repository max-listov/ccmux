import { join } from 'node:path';
import type { AgentHarnessProfileEvent } from 'stitchkit/agent-runtime/harness';
import { z } from 'zod';
import { RuntimeAppliedProfileSchema } from '../../policy/runtimeProfile.ts';
import { readPrivateJson } from '../../runtime/store.ts';
import type { Session } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import type { openCustomEngine } from './engine.ts';
import type { PreparedCustomHost } from './host.ts';

const StoredProfileSchema = z
  .object({ registration: z.uuid(), nativeId: z.string(), profile: RuntimeAppliedProfileSchema })
  .strict();
export class CustomProfile {
  constructor(
    private root: string,
    private session: Session,
    private host: PreparedCustomHost,
  ) {}
  async applied(event: AgentHarnessProfileEvent) {
    if (
      event.conversationId !== this.session.nativeSession?.id ||
      !this.host.config.models.some(
        ({ selection }) =>
          selection.provider === event.model.provider && selection.model === event.model.modelId,
      ) ||
      event.toolNames.some((name) => !this.host.config.tools.some((tool) => tool === name)) ||
      event.diagnostics.length > 0
    )
      throw new Error('Native applied profile differs from its host authority');
    const resources = event.resources.map((resource) => {
      const source = this.host.resources.find(
        (source) =>
          resource.provenance ===
          `${source.id}:${source.kind === 'skill' ? 'SKILL.md' : `${source.id}.md`}`,
      );
      if (!source || source.kind !== resource.kind)
        throw new Error('Native resource provenance differs');
      return { id: source.id, kind: source.kind, digest: source.sha256 };
    });
    const profile = RuntimeAppliedProfileSchema.parse({
      runtime: 'custom',
      turnId: event.runId,
      observedAt: new Date().toISOString(),
      recipeDigest: this.session.launchRecipe?.digest,
      model: { provider: event.model.provider, model: event.model.modelId },
      tools: event.toolNames,
      resources,
    });
    await atomicWrite(
      join(this.root, 'profile.json'),
      JSON.stringify(
        StoredProfileSchema.parse({
          registration: this.session.registrationGeneration,
          nativeId: event.conversationId,
          profile,
        }),
      ),
      0o600,
    );
    return profile;
  }
  async read(engine: Awaited<ReturnType<typeof openCustomEngine>>) {
    const saved = readPrivateJson(join(this.root, 'profile.json'), StoredProfileSchema, 16 * 1024);
    if (!saved) return null;
    if (
      saved.registration !== this.session.registrationGeneration ||
      saved.nativeId !== this.session.nativeSession?.id ||
      saved.profile.recipeDigest !== this.session.launchRecipe?.digest ||
      !(await engine.sqlite.store.loadRun({
        conversationId: saved.nativeId,
        runId: saved.profile.turnId,
      }))
    )
      throw new Error('Retained profile has no canonical native run');
    return saved.profile;
  }
}
