import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createControlOperations } from '../src/control/operations.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { ControlModelsReadSchema } from '../src/control/schema/model.ts';
import { ExternalStatusPublisher } from '../src/external/residentPublisher.ts';
import { makeMachine } from './helpers.ts';

function fixture() {
  const root = mkdtempSync('/tmp/ccmux-catalog-test-');
  const bin = join(root, 'codex');
  copyFileSync(join(import.meta.dir, 'fixtures/catalog-server.ts'), bin);
  chmodSync(bin, 0o700);
  const machine = makeMachine({ codexBin: bin, codexHome: root, stateDir: join(root, 'state') });
  return { root, machine };
}

test('the host catalog operation answers from the daemon read, dated when it was observed', async () => {
  const f = fixture();
  const control = createControlOperations(
    f.machine,
    new ControlPublisher(f.machine),
    new ExternalStatusPublisher(f.machine.rcPrefix),
  );
  try {
    const input = ControlModelsReadSchema.parse({ runtime: 'codex' });
    const first = await control.operations.models(input);
    // A read computed on the spot carries no observation instant; one served from the host read does.
    expect(first.source.observedAt).not.toBeNull();
    expect(first.source.freshness).toBe('live');
    expect(first.data[0]).toMatchObject({ id: 'preset-a', model: 'model-a' });
    const second = await control.operations.models(input);
    expect(second.source.observedAt).toBe(first.source.observedAt);
  } finally {
    control.catalog.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
