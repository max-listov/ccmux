import { existsSync } from 'node:fs';
import { loadMachineConfig } from '../config/machine.ts';
import { APP_BUNDLE, STAGED_BUNDLE } from '../config/paths.ts';
import {
  applyLocal,
  bundleVersion,
  decideUpdate,
  downloadVerifyApply,
  type FetchedRelease,
  fetchRelease,
  rollback,
} from '../release/update.ts';
import { log } from '../util/log.ts';
import { VERSION } from '../util/version.ts';
import { parseFlags } from './flags.ts';

type UpdateOpts = { check: boolean; force: boolean; rollback: boolean };

function parseOpts(args: string[]): UpdateOpts {
  const flags = parseFlags('update', args, [0, 0]);
  return {
    check: flags.bool('check'),
    force: flags.bool('force'),
    rollback: flags.bool('rollback'),
  };
}

export async function cmdUpdate(args: string[]): Promise<number> {
  const o = parseOpts(args);
  const m = loadMachineConfig();
  if (o.rollback) return rollback(m);

  // Resolve the two candidate versions (this is the only IO; the DECISION is pure below).
  const stagedPresent = existsSync(STAGED_BUNDLE);
  const staged = stagedPresent ? await bundleVersion(STAGED_BUNDLE) : null;
  let release: FetchedRelease | null = null;
  if (!stagedPresent && m.releaseUrl !== undefined) {
    const r = await fetchRelease(m.releaseUrl);
    if (typeof r === 'string') {
      console.log(`update: ${r}`);
      return 1;
    }
    release = r;
  }

  const decision = decideUpdate({
    check: o.check,
    force: o.force,
    current: VERSION,
    staged,
    release: release?.version ?? null,
    releaseNotes: release?.notes,
    hasReleaseUrl: m.releaseUrl !== undefined,
    bundlePresent: existsSync(APP_BUNDLE),
  });

  switch (decision.kind) {
    case 'print':
      console.log(decision.text);
      return decision.code;
    case 'apply-staged':
      return applyLocal(m);
    case 'apply-remote': {
      if (release === null) {
        console.log('update: internal — apply-remote with no release resolved');
        return 1;
      }
      console.log(`updating ${VERSION} → ${release.version}…`);
      log.info({ msg: 'update: applying remote release', from: VERSION, to: release.version });
      const err = await downloadVerifyApply(m, release);
      if (err) {
        log.error({ msg: 'update failed', to: release.version, err });
        console.log(`update: ${err}`);
        return 1;
      }
      console.log(
        `updated to ${release.version}. daemon bounced; sessions keep running. rollback: ccmux update --rollback`,
      );
      return 0;
    }
  }
}
