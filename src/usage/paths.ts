import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MachineConfig } from '../types.ts';

export const liveUsagePath = (m: Pick<MachineConfig, 'stateDir'>, uuid: string) =>
  join(m.stateDir, 'usage', `${createHash('sha256').update(uuid).digest('hex')}.sqlite`);
