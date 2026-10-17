import { randomUUID } from 'node:crypto';
import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { expectedSelection, menuFingerprint, navigationKey } from '../agent/claude/menuStep.ts';
import { liveFrame, terminalMenu } from '../agent/claude/prompts.ts';

/** The menu on screen now; a screen whose footer belongs to a frame drawn over is not one. */
const menuOf = (text: string) => {
  const frame = liveFrame(text);
  return frame === null ? null : terminalMenu(frame);
};

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
const fingerprint = menuFingerprint;

/** One short-lived, single-use observation per exact session. Terminal input is not a provider CAS. */
export class TerminalPrompts {
  private observations = new Map<string, Observation>();
  constructor(private m: MachineConfig) {}
  private async pane(target: ManagedPeer) {
    const session = controlTarget(this.m, target);
    if (session.agent !== 'claude' || (session.runtime && session.runtime !== 'tui'))
      throw new AppError('UNSUPPORTED', {
        message: 'Terminal menus require an interactive Claude session',
        status: 409,
      });
    const state = await listAgentLiveness(this.m);
    const pane = state.agentPanes.get(session.name);
    if (!pane || !state.live.has(session.name))
      throw new AppError('UNAVAILABLE', {
        message: 'The recorded agent pane is unavailable',
        status: 409,
      });
    return pane;
  }
  private async command(_pane: string, ...args: string[]) {
    const result = await run(tmuxArgv(this.m, ...args));
    if (result.code !== 0)
      throw new AppError('UNAVAILABLE', { message: 'The terminal operation failed', status: 409 });
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
      throw new AppError('STALE_PROMPT', {
        message: 'The terminal changed during observation',
        status: 409,
      });
    const menu = menuOf(text);
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
      throw new AppError('CAPACITY', {
        message: 'Terminal observation capacity reached',
        status: 429,
      });
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
        new AppError('STALE_PROMPT', {
          message: 'Read the current terminal menu before responding',
          status: 409,
        });
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
          const menu = menuOf(text);
          if (fingerprint(text) !== observation.fingerprint || !menu || menu.selected === null)
            throw stale();
          const desired = menu.options.findIndex((o) => o.id === input.optionId);
          if (desired < 0)
            throw new AppError('INVALID_OPTION', {
              message: 'The menu does not offer that option',
              status: 400,
            });
          observation.consumed = true;
          const key = navigationKey(menu.selected, desired);
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
            const nextMenu = menuOf(next);
            if (fingerprint(next) !== observation.fingerprint || !nextMenu) throw stale();
            // Exactly one option nearer: a jump, a wrap past the end or an unrelated change is not
            // the key's doing, and pressing again from there would be navigating a menu we lost.
            if (nextMenu.selected === expectedSelection(menu.selected, key)) {
              moved = true;
              break;
            }
            if (nextMenu.selected !== menu.selected) throw stale();
          }
          if (!moved)
            throw new AppError('PROMPT_UNCONFIRMED', {
              message: 'Terminal selection did not advance',
              status: 409,
            });
        }
        throw new AppError('PROMPT_UNCONFIRMED', {
          message: 'Terminal navigation budget exhausted',
          status: 409,
        });
      } finally {
        await this.command(pane, 'select-pane', '-e', '-t', pane);
      }
    });
  }
}
