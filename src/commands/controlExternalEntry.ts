import { runControlExternal } from './controlExternal.ts';

// Same public command and domain snapshot; only the bundle startup is bypassed.
if (process.argv.slice(2).join('\0') !== 'control\0external\0--json') process.exitCode = 2;
else process.exitCode = await runControlExternal();
