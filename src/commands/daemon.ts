import { loadMachineConfig } from "../config/machine.ts";
import { APP_BUNDLE, BOOT_ATTEMPTS } from "../config/paths.ts";
import { convergeBundleLocation } from "../config/migrateBundle.ts";
import { cmdEnsure } from "./ensure.ts";
import { autoUpdateOnce } from "./update.ts";
import { observeOnce, type Observed } from "../events/observe.ts";
import { deliverPending } from "../chat/deliver.ts";
import { mirrorPending } from "../chat/telegram.ts";
import { flushOutbox } from "../fleet/flush.ts";
import { bootGuardStart, clearBootGuard } from "../util/bootGuard.ts";
import { IS_DEV } from "../env.ts";
import { log, setLogLevel } from "../util/log.ts";

// Chat delivery runs on its OWN fast cadence, not the 30s heal tick — a message should reach an
// idle peer within a few seconds, not up to half a minute. Cheap when idle (only recipients with
// a pending message ever scrape a pane), so a tight interval costs nothing on a quiet fleet.
const CHAT_DELIVER_INTERVAL_MS = 3_000;
// Faster than chat delivery on purpose: a menu a session is stuck at, and a turn that was
// interrupted, are both states a person is actively waiting to be told about.
const SESSION_EVENT_INTERVAL_MS = 2_000;

/** Independent push-delivery loop (fire-and-forget from the daemon). Bounces with the daemon on
 *  auto-update; one bad pass never stops it. */
/**
 * Watch what the turn hook cannot see: publish what changed, and keep this machine's own record of
 * what its sessions are doing.
 *
 * Its own loop, on its own cadence, for the same reason chat delivery has one: the heal pass runs
 * every 30 seconds by default, and "a session has been waiting at a menu" is stale news at that
 * interval. The cost is a pane capture per running session per pass — which is precisely what an
 * outside surface used to pay by polling `list --json` on a timer, except paid once here and
 * published to everyone instead of once per consumer.
 *
 * It runs whether or not events are switched on, and the switch is applied per session inside the
 * pass, to what gets APPENDED. Two of the things this loop maintains are not a feature anybody
 * subscribed to: a `working` stamp left behind by a turn that ended without its hook, and the
 * record of when each pane was last seen working. `list`, the TUI, `ccmux wait` and chat delivery
 * all read those whether or not a feed exists, so gating them on an events toggle would let
 * switching off a publication quietly weaken delivery.
 *
 * The memory of the previous observation lives in this process only — apart from the pane record,
 * which is written down precisely because a fresh process cannot have it. A daemon bounce therefore
 * re-observes rather than replaying: whatever is true after the bounce is emitted once, and nothing
 * that happened while it was down is invented.
 */
async function sessionEventLoop(): Promise<void> {
  const previous = new Map<string, Observed>();
  for (;;) {
    try {
      await observeOnce(loadMachineConfig(), previous);
    } catch (e) {
      log.warn({ msg: "session event pass failed", err: String(e) });
    }
    await Bun.sleep(SESSION_EVENT_INTERVAL_MS);
  }
}

async function chatDeliveryLoop(): Promise<void> {
  for (;;) {
    try {
      const m = loadMachineConfig();
      await deliverPending(m); // push to peer panes (menu-safe)
      await mirrorPending(m); // mirror to Telegram (fail-soft; no-op when unconfigured)
      await flushOutbox(m); // re-send cross-machine mail that never left (no-op without a fleet map)
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
    // The daemon is the one process guaranteed to run with the privileges this needs, and it is
    // what a post-update bounce starts — so the move off the cache root lands here, once.
    if (!IS_DEV) await convergeBundleLocation(m);
  } catch (e) {
    log.error({ msg: "machine config invalid; daemon not starting", err: String(e) });
    return 0;
  }

  // Start the chat push-delivery loop alongside the heal loop (independent fast cadence).
  void chatDeliveryLoop();
  // …and the observation loop that publishes what the turn hook cannot see.
  void sessionEventLoop();

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
