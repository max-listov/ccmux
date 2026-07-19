import { loadMachineConfig } from "../config/machine.ts";
import { APP_BUNDLE, BOOT_ATTEMPTS } from "../config/paths.ts";
import { cmdEnsure } from "./ensure.ts";
import { autoUpdateOnce } from "./update.ts";
import { deliverPending } from "../chat/deliver.ts";
import { mirrorPending } from "../chat/telegram.ts";
import { bootGuardStart, clearBootGuard } from "../util/bootGuard.ts";
import { IS_DEV } from "../env.ts";
import { log, setLogLevel } from "../util/log.ts";

// Chat delivery runs on its OWN fast cadence, not the 30s heal tick — a message should reach an
// idle peer within a few seconds, not up to half a minute. Cheap when idle (only recipients with
// a pending message ever scrape a pane), so a tight interval costs nothing on a quiet fleet.
const CHAT_DELIVER_INTERVAL_MS = 3_000;

/** Independent push-delivery loop (fire-and-forget from the daemon). Bounces with the daemon on
 *  auto-update; one bad pass never stops it. */
async function chatDeliveryLoop(): Promise<void> {
  for (;;) {
    try {
      const m = loadMachineConfig();
      await deliverPending(m); // push to peer panes (menu-safe)
      await mirrorPending(m); // mirror to Telegram (fail-soft; no-op when unconfigured)
    } catch (e) {
      log.warn({ msg: "chat delivery pass failed", err: String(e) });
    }
    await Bun.sleep(CHAT_DELIVER_INTERVAL_MS);
  }
}

/**
 * The session-level supervisor. A plain foreground loop that creates tmux sessions
 * as children which OUTLIVE it — so `update`/restart can bounce this process without
 * dropping a live conversation. Run by the boot unit (systemd/launchd).
 */
export async function cmdDaemon(): Promise<number> {
  installSignals();

  // Boot-loop guard: a crash-looping (freshly auto-updated) bundle reverts itself to .bak
  // after MAX_ATTEMPTS starts without one good ensure pass. Exit non-zero → boot unit
  // relaunches onto the restored bundle. It guards the PROD BUNDLE only: from live source
  // (dev, esp. under `bun --watch`) there is no bundle/.bak to revert, and rapid edit-driven
  // restarts would only churn the counter into false "boot-loop" errors — so skip it in dev.
  if (!IS_DEV && bootGuardStart(BOOT_ATTEMPTS, APP_BUNDLE) === "revert") return 1;

  // P1-7: validate config at startup. On failure exit 0 + loud log so launchd/systemd
  // don't thrash-respawn a misconfigured box — it stays down loudly-once.
  let interval: number;
  try {
    const m = loadMachineConfig();
    interval = m.ensureInterval;
    setLogLevel(m.logLevel);
    log.info({ msg: "ccmux daemon up", rcPrefix: m.rcPrefix, interval, logLevel: m.logLevel });
  } catch (e) {
    log.error({ msg: "machine config invalid; daemon not starting", err: String(e) });
    return 0;
  }

  // Start the chat push-delivery loop alongside the heal loop (independent fast cadence).
  void chatDeliveryLoop();

  let lastUpdateCheck = 0;
  let guardCleared = false;
  for (;;) {
    try {
      await cmdEnsure();
      if (!IS_DEV && !guardCleared) {
        clearBootGuard(BOOT_ATTEMPTS); // first good pass — this bundle works
        guardCleared = true;
      }
    } catch (e) {
      log.error({ msg: "ensure pass failed", err: String(e) }); // one bad pass never kills the daemon
    }
    try {
      const m = loadMachineConfig(); // live re-read so edited interval/autoUpdate/logLevel applies
      interval = m.ensureInterval;
      setLogLevel(m.logLevel);
      // auto-update: throttled to updateCheckInterval; applies a newer release (bounce → restart)
      if (m.autoUpdate && Date.now() - lastUpdateCheck >= m.updateCheckInterval * 1000) {
        lastUpdateCheck = Date.now();
        await autoUpdateOnce(m); // on success this swaps + bounces → the daemon is restarted onto it
      }
    } catch (e) {
      log.warn({ msg: "config re-read / auto-update failed; keeping last interval", interval, err: String(e) });
    }
    await Bun.sleep(interval * 1000);
  }
}

/** 128+signum — the shell convention for death-by-signal. Exported for the test. */
export function signalExitCode(sig: NodeJS.Signals): number {
  return sig === "SIGINT" ? 130 : 143;
}

function installSignals(): void {
  // Exit NON-zero on signals: a stray SIGTERM (a neighbor's unscoped `pkill bun`,
  // incident 2026-06-11) must bring the daemon back via KeepAlive SuccessfulExit=false /
  // Restart=on-failure. Every INTENTIONAL stop path is exit-code-agnostic: uninstall
  // does `bootout` / `systemctl disable --now` (job unloaded / manual stop — never
  // restarted), update/restart bounce via `kickstart -k` / `systemctl restart` (always
  // restarted). Exit 0 stays reserved for the invalid-config "stay down loudly-once" path.
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const sig of signals) {
    process.on(sig, () => {
      const code = signalExitCode(sig);
      log.info({ msg: "daemon stopping", sig, code });
      process.exit(code);
    });
  }
}
