import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClientDeclarations } from '../scripts/client-declarations.ts';

test('packed ESM types resolve file and directory imports and preserve literal types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccmux-client-types-'));
  try {
    const path = join(root, 'client.d.ts');
    await mkdir(join(root, 'dir'));
    await Bun.write(join(root, 'schema.d.ts'), 'export interface Schema { id: string }');
    await Bun.write(join(root, 'dir/index.d.ts'), 'export type D = number;');
    const source = [
      "/* ./schema.ts */ export type { Schema } from './schema.ts';",
      "export type D = import('./dir').D;",
      "export type FileName = './schema.ts';",
    ];
    await Bun.write(path, source.join('\n'));
    await normalizeClientDeclarations(root);
    const text = await Bun.file(path).text();
    expect(text).toContain('from "./schema.js"');
    expect(text).toContain('import("./dir/index.js")');
    expect(text).toContain("export type FileName = './schema.ts';");
    expect(text).toContain('/* ./schema.ts */');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unresolved relative type prevents publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccmux-missing-types-'));
  try {
    await Bun.write(join(root, 'client.d.ts'), "export type { Unknown } from './missing.ts';");
    await expect(normalizeClientDeclarations(root)).rejects.toThrow(
      'Unresolved declaration import',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
