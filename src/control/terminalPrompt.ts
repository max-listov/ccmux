import { createHash, randomUUID } from 'node:crypto';
import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { paneTail, terminalMenu } from '../agent/claude/prompts.ts';
import { withSessionRegistryLock } from '../session/registryLock.ts';
import { listAgentLiveness } from '../tmux/agentPane.ts';
import { tmuxArgv } from '../tmux/argv.ts';
import type { MachineConfig, ManagedPeer } from '../types.ts';
import { run } from '../util/spawn.ts';
import {
  TerminalPromptReceiptSchema,
  type TerminalPromptRespondSchema,
} from './schema/terminalPrompt.ts';
import { controlTarget } from './target.ts';

type Observation = {
  id: string;
  pane: string;
  generation: string;
  fingerprint: string;
  expires: number;
  consumed: boolean;
};
const fingerprint = (text: string) =>
  createHash('sha256')
    .update(
      paneTail(text, 40)
        .replaceAll('❯', ' ')
        .split('\n')
        .map((l) => l.trim())
        .join('\n'),
    )
    .digest('hex');

/** One short-lived, single-use observation per exact session. Terminal input is not a provider CAS. */
export class TerminalPrompts {
  private observations = new Map<string, Observation>();
  constructor(private m: MachineConfig) {}
  private async pane(target: ManagedPeer) {
    const session = controlTarget(this.m, target);
    if (session.agent !== 'claude' || (session.runtime && session.runtime !== 'tui'))
      throw new AppError(
        'UNSUPPORTED',
        'Terminal menus require an interactive Claude session',
        409,
      );
    const state = await listAgentLiveness(this.m);
    const pane = state.agentPanes.get(session.name);
    if (!pane || !state.live.has(session.name))
      throw new AppError('UNAVAILABLE', 'The recorded agent pane is unavailable', 409);
    return pane;
  }
  private async command(_pane: string, ...args: string[]) {
    const result = await run(tmuxArgv(this.m, ...args));
    if (result.code !== 0) throw new AppError('UNAVAILABLE', 'The terminal operation failed', 409);
    return result.stdout;
  }
  private capture(pane: string) {
    return this.command(pane, 'capture-pane', '-t', pane, '-p');
  }
  private generation(pane: string) {
    return this.command(
      pane,
      'display-message',
      '-p',
      '-t',
      pane,
      '#{pid}:#{pane_id}:#{pane_pid}:#{session_created}',
    );
  }
  async read(target: ManagedPeer) {
    const pane = await this.pane(target);
    const generation = await this.generation(pane);
    const text = await this.capture(pane);
    if (generation !== (await this.generation(pane)))
      throw new AppError('STALE_PROMPT', 'The terminal changed during observation', 409);
    const menu = terminalMenu(text);
    const now = Date.now();
    for (const [key, value] of this.observations)
      if (!value.consumed && value.expires <= now) this.observations.delete(key);
    const previous = this.observations.get(target.threadId);
    if (
      previous &&
      previous.pane === pane &&
      previous.generation === generation &&
      previous.fingerprint === fingerprint(text)
    ) {
      return {
        target,
        menu,
        observationId: previous.consumed ? null : previous.id,
        expiresAt: previous.consumed ? null : new Date(previous.expires).toISOString(),
      };
    }
    this.observations.delete(target.threadId);
    if (!menu?.options.length) return { target, menu, observationId: null, expiresAt: null };
    if (this.observations.size >= 256)
      throw new AppError('CAPACITY', 'Terminal observation capacity reached', 429);
    const observation = {
      id: randomUUID(),
      pane,
      generation,
      fingerprint: fingerprint(text),
      expires: now + 30_000,
      consumed: false,
    };
    this.observations.set(target.threadId, observation);
    return {
      target,
      menu,
      observationId: observation.id,
      expiresAt: new Date(observation.expires).toISOString(),
    };
  }
  async respond(input: z.infer<typeof TerminalPromptRespondSchema>, signal: AbortSignal) {
    return withSessionRegistryLock(this.m, async () => {
      const { target } = input;
      const observation = this.observations.get(target.threadId);
      const stale = () =>
        new AppError('STALE_PROMPT', 'Read the current terminal menu before responding', 409);
      if (
        !observation ||
        observation.consumed ||
        observation.id !== input.observationId ||
        observation.expires <= Date.now()
      )
        throw stale();
      const pane = await this.pane(target);
      if (pane !== observation.pane || (await this.generation(pane)) !== observation.generation)
        throw stale();
      // Hold human input while inspecting. Each key is enqueued together with re-closing the gate.
      await this.command(pane, 'select-pane', '-d', '-t', pane);
      try {
        for (let step = 0; step < 20; step++) {
          signal.throwIfAborted();
          controlTarget(this.m, target);
          if ((await this.generation(pane)) !== observation.generation) throw stale();
          const text = await this.capture(pane);
          const menu = terminalMenu(text);
          if (fingerprint(text) !== observation.fingerprint || !menu || menu.selected === null)
            throw stale();
          const desired = menu.options.findIndex((o) => o.id === input.optionId);
          if (desired < 0)
            throw new AppError('INVALID_OPTION', 'The menu does not offer that option', 400);
          observation.consumed = true;
          const key = desired === menu.selected ? 'Enter' : desired > menu.selected ? 'Down' : 'Up';
          await this.command(
            pane,
            'select-pane',
            '-e',
            '-t',
            pane,
            ';',
            'send-keys',
            '-t',
            pane,
            key,
            ';',
            'select-pane',
            '-d',
            '-t',
            pane,
          );
          if (key === 'Enter')
            return TerminalPromptReceiptSchema.parse({ ...input, outcome: 'submitted' });
          // Wait for this single navigation key to render; never repeat it against the old selection.
          const deadline = Date.now() + 1_000;
          let moved = false;
          while (Date.now() < deadline) {
            signal.throwIfAborted();
            await Bun.sleep(20);
            const next = await this.capture(pane);
            const nextMenu = terminalMenu(next);
            if (fingerprint(next) !== observation.fingerprint || !nextMenu) throw stale();
            if (nextMenu.selected !== menu.selected) {
              moved = true;
              break;
            }
          }
          if (!moved)
            throw new AppError('PROMPT_UNCONFIRMED', 'Terminal selection did not advance', 409);
        }
        throw new AppError('PROMPT_UNCONFIRMED', 'Terminal navigation budget exhausted', 409);
      } finally {
        await this.command(pane, 'select-pane', '-e', '-t', pane);
      }
    });
  }
}
