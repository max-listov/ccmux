import { cmdControlExternal } from './controlExternal.ts';

// Same public command and domain snapshot; only the bundle startup is bypassed.
if (process.argv.slice(2).join('\0') !== 'control\0external\0--json') process.exitCode = 2;
else {
  try {
    process.exitCode = await cmdControlExternal();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
