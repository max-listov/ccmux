import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCodexCatalogRuntime } from '../../src/agent/codex/catalogRuntime.ts';
import { MachineConfigSchema } from '../../src/config/machineSchema.ts';

const root = process.argv[2];
const executable = process.argv[3];
if (!root || !executable) throw new Error('Catalog owner fixture requires root and executable');
const machine = MachineConfigSchema.parse({
  claudeBin: '/bin/false',
  tmuxBin: '/bin/false',
  codexBin: executable,
  codexHome: root,
  stateDir: join(root, 'state'),
  rcPrefix: 'host-a',
  projectsDir: root,
  bootLabel: 'test',
});
await withCodexCatalogRuntime(
  machine,
  { flags: [] },
  root,
  AbortSignal.timeout(15_000),
  async (rpc) => {
    writeFileSync(join(root, 'initialized'), 'ready');
    await rpc.request('model/list', { cursor: 'hang' });
  },
);
