import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { installBoot, uninstallBoot } from '../boot/install.ts';
import { loadMachineConfig, scaffoldMachineConfig } from '../config/machine.ts';
import { RC_PREFIX_RE } from '../config/schema.ts';
import { HOME, PLATFORM } from '../env.ts';
import { atomicWrite } from '../util/atomic.ts';

function configPath(): string {
  return process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`;
}

function parseRcPrefix(args: string[]): string | undefined {
  const i = args.indexOf('--rc-prefix');
  if (i !== -1) return args[i + 1];
  return args.find((a) => !a.startsWith('-'));
}

function parseReleaseUrl(args: string[]): string | undefined {
  const i = args.indexOf('--release-url');
  return i !== -1 ? args[i + 1] : undefined;
}

function isRcPrefix(v: string | undefined): v is string {
  return v !== undefined && RC_PREFIX_RE.test(v);
}

/**
 * Why a re-install may not rename. A machine's rcPrefix is its NAME on the fleet: every session
 * registers its Remote Control identity from it, so changing it orphans running sessions from the
 * names they are addressed by. Install doubles as the repair command, and a repair that renames the
 * patient is not a repair — which is exactly why the installer could not be pointed at a broken
 * machine before. Pure so the rule is testable without touching a boot manager.
 */
export function renameRefusal(
  current: string,
  requested: string | undefined,
  force: boolean,
): string | null {
  if (requested === undefined || requested === current || force) return null;
  return (
    `this machine is already '${current}' — refusing to rename it to '${requested}'. ` +
    "rcPrefix is the machine's fleet identity; renaming it changes every session's Remote Control name. " +
    'Pass --force if that is genuinely what you want.'
  );
}

export async function cmdInstall(args: string[]): Promise<number> {
  const cfg = configPath();
  const rc = parseRcPrefix(args);
  const releaseUrl = parseReleaseUrl(args);
  try {
    if (!existsSync(cfg)) {
      if (!isRcPrefix(rc)) {
        console.log(
          'no machine.json yet — run: ccmux install --rc-prefix <name> (lowercase slug, e.g. local, dev, prod)',
        );
        return 1;
      }
      const scaffolded = scaffoldMachineConfig(rc);
      // --release-url wires self-update on first install: point at a release.json + turn
      // autoUpdate on, so a client tracks the published fleet version from the start.
      const withUpdate = releaseUrl ? { ...scaffolded, releaseUrl, autoUpdate: true } : scaffolded;
      mkdirSync(dirname(cfg), { recursive: true });
      await atomicWrite(cfg, `${JSON.stringify(withUpdate, null, 2)}\n`);
      console.log(`wrote ${cfg} (rcPrefix=${rc}${releaseUrl ? `, autoUpdate→${releaseUrl}` : ''})`);
    } else if (isRcPrefix(rc) || releaseUrl !== undefined) {
      const current = loadMachineConfig();
      const refusal = renameRefusal(
        current.rcPrefix,
        isRcPrefix(rc) ? rc : undefined,
        args.includes('--force'),
      );
      if (refusal !== null) {
        console.log(refusal);
        return 1;
      }
      // Re-install over an EXISTING config: apply the passed flags (the rest is preserved), so
      // `install --release-url …` actually rewires self-update instead of being silently ignored.
      const updated = {
        ...current,
        ...(isRcPrefix(rc) ? { rcPrefix: rc } : {}),
        ...(releaseUrl !== undefined ? { releaseUrl, autoUpdate: true } : {}),
      };
      await atomicWrite(cfg, `${JSON.stringify(updated, null, 2)}\n`);
      console.log(
        `updated ${cfg}${isRcPrefix(rc) ? ` (rcPrefix=${rc})` : ''}${releaseUrl !== undefined ? `, autoUpdate→${releaseUrl}` : ''}`,
      );
    }
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const m = loadMachineConfig();
  console.log(`detected: claude=${m.claudeBin} tmux=${m.tmuxBin} projects=${m.projectsDir}`);
  await installBoot(m);
  console.log(
    `install complete (${PLATFORM === 'darwin' ? 'launchd' : 'systemd'}). daemon running.`,
  );
  return 0;
}

export async function cmdUninstall(): Promise<number> {
  const m = loadMachineConfig();
  await uninstallBoot(m);
  console.log('uninstalled. sessions file + jsonl history kept on disk.');
  return 0;
}
