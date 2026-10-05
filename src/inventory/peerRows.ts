import { INVENTORY_FRESH_MS } from '../monitoring/tmux.ts';
import type { MachineConfig } from '../types.ts';
import { collectRows, type ListRow } from './rows.ts';

type Observation = NonNullable<NonNullable<Parameters<typeof collectRows>[1]>['observation']>;

/** A fresh observation shares one row build. Gaps use the same cold collector as local list. */
export class PeerRows {
  private observation: { machine: MachineConfig; at: number; value: Observation } | null = null;
  private rows: Promise<ListRow[]> | null = null;

  observe(machine: MachineConfig, value: Observation, at = Date.now()): void {
    this.observation = { machine, at, value };
    this.rows = null;
  }

  read(machine: MachineConfig): Promise<ListRow[]> {
    const observation = this.observation;
    if (observation === null || Date.now() - observation.at > INVENTORY_FRESH_MS)
      return collectRows(machine);
    if (!this.rows) {
      const pending = collectRows(observation.machine, { observation: observation.value });
      this.rows = pending;
      void pending.catch(() => {
        if (this.rows === pending) this.rows = null;
      });
    }
    return this.rows;
  }
}
