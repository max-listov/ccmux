// Isolated process: mocking filesystem latency must never affect other tests or real state.
import { expect, mock } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';

const originalOpen = fs.open;
let calls = 0;
let resume: () => void = () => {
  throw new Error('gate not initialized');
};
const gate = new Promise<void>((resolve) => {
  resume = resolve;
});
const mode = Bun.argv[2];
const config = process.env.CCMUX_CONFIG;
if (!config) throw new Error('isolated config required');
mock.module('node:fs/promises', () => ({
  ...fs,
  open: async (...args: Parameters<typeof originalOpen>) => {
    calls++;
    if (mode === 'hang' && calls === 1) await gate;
    if (mode === 'migration' && calls === 3) {
      writeFileSync(
        config,
        JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), rcPrefix: 'host-b' }),
      );
    }
    return originalOpen(...args);
  },
}));
const { MONITORING_MAX_TIMEOUT_MS, readMonitoringStatus } = await import(
  '../../src/monitoring-reader.ts'
);
/**
 * A read whose subject is not its deadline gets the longest one the reader allows. The default of
 * 250 ms is a product bound for a live consumer, and on a machine loaded by other work this
 * process's first reads exceed it — the answer was `deadline`, not what the line checks.
 */
const unhurried = { timeoutMs: MONITORING_MAX_TIMEOUT_MS };
if (mode === 'hang') {
  expect((await readMonitoringStatus({ timeoutMs: 5 })).reason).toBe('deadline');
  for (let i = 0; i < 100; i++) {
    expect((await readMonitoringStatus({ timeoutMs: 1 })).reason).toBe('deadline');
    const stop = new AbortController();
    const request = readMonitoringStatus({ signal: stop.signal });
    stop.abort();
    expect((await request).reason).toBe('cancelled');
  }
  expect(calls).toBe(1); // Hung I/O remains single-flight; abandoned callers do not retry it.
  resume();
  expect((await readMonitoringStatus(unhurried)).status).toBe('live');
  expect(calls).toBe(3);
  expect((await readMonitoringStatus(unhurried)).status).toBe('live');
  expect(calls).toBe(6); // No completed-result cache, even immediately after the previous read.
} else if (mode === 'migration') {
  expect((await readMonitoringStatus(unhurried)).reason).toBe('config-changed');
  expect((await readMonitoringStatus(unhurried)).reason).toBe('invalid'); // Old snapshot cannot pass the new identity.
} else throw new Error('unknown fixture mode');
console.log('native I/O proof OK');
