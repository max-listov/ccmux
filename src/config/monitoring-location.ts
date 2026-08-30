import { HOME } from '../env.ts';
import { STATE_DIR } from './paths.ts';
import { MachineConfigSchema } from './schema.ts';

const LocationSchema = MachineConfigSchema.pick({ stateDir: true, rcPrefix: true }).partial();

/** Owner configuration selection, shared by the daemon and native monitoring reader. */
export function machineConfigPath(): string {
  return process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`;
}

export function resolveMonitoringLocation(raw: unknown): { stateDir: string; rcPrefix: string } {
  const file = LocationSchema.parse(raw);
  return {
    stateDir: file.stateDir ?? STATE_DIR,
    rcPrefix: process.env.CCMUX_RC_PREFIX || file.rcPrefix || 'local',
  };
}
