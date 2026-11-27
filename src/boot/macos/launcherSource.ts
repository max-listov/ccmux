import { join } from 'node:path';

export const MACOS_APP_NAME = 'ccmux.app';
export const MACOS_LAUNCHER_NAME = 'ccmux-launcher';
export const MACOS_DEFAULT_BUNDLE_ID = 'com.ccmux.app';

/** Installed path of the signed background `.app` bundle on macOS. */
export function macosAppPath(home: string): string {
  const override = process.env.CCMUX_MACOS_APP_PATH;
  if (override?.startsWith('/')) return override;
  return join(home, 'Applications', MACOS_APP_NAME);
}

/** Launcher executable inside `ccmux.app` — prepended only to macOS LaunchAgent ProgramArguments. */
export function macosLauncherPath(home: string): string {
  return join(macosAppPath(home), 'Contents', 'MacOS', MACOS_LAUNCHER_NAME);
}

/**
 * Thin signed macOS LaunchAgent wrapper.
 *
 * Spawns argv[1..] via `posix_spawnp` WITHOUT `POSIX_SPAWN_SETEXEC` and WITHOUT
 * `responsibility_spawnattrs_setdisclaim`, staying alive as the responsible parent process so
 * macOS attributes TCC/Local Network/Automation/Screen Recording permissions of supervised
 * services and tmux sessions to the signed `ccmux.app` bundle rather than bare `bun` or `tmux`.
 *
 * Production builds refuse direct shell invocation (`getppid() != 1`, exit 125) so arbitrary
 * shell processes cannot invoke the signed bundle directly; tests compile with
 * `-DCCMUX_LAUNCHER_ALLOW_NON_LAUNCHD`.
 */
export const MACOS_LAUNCHER_C = `#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t child_pid = 0;

static void forward_signal(int signo) {
  int saved_errno = errno;
  pid_t pid = (pid_t)child_pid;
  if (pid > 0) kill(pid, signo);
  errno = saved_errno;
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: ccmux-launcher <program> [args...]\\n");
    return 2;
  }

#ifndef CCMUX_LAUNCHER_ALLOW_NON_LAUNCHD
  if (getppid() != 1) {
    fprintf(stderr, "ccmux-launcher: refused — must be launched directly by launchd (ppid=1, got %d)\\n",
            (int)getppid());
    return 125;
  }
#endif

  const int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
  sigset_t block, previous;
  sigemptyset(&block);
  for (size_t i = 0; i < sizeof signals / sizeof *signals; i++) {
    sigaddset(&block, signals[i]);
  }
  /* Block signals before installing handlers so none are lost before child_pid is published. */
  if (sigprocmask(SIG_BLOCK, &block, &previous) != 0) {
    fprintf(stderr, "ccmux-launcher: sigprocmask(SIG_BLOCK): %s\\n", strerror(errno));
    return 126;
  }

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  for (size_t i = 0; i < sizeof signals / sizeof *signals; i++) {
    if (sigaction(signals[i], &action, NULL) != 0) {
      fprintf(stderr, "ccmux-launcher: sigaction(%d): %s\\n", signals[i], strerror(errno));
      return 126;
    }
  }

  posix_spawnattr_t attrs;
  int rc = posix_spawnattr_init(&attrs);
  if (rc != 0) {
    fprintf(stderr, "ccmux-launcher: posix_spawnattr_init: %s\\n", strerror(rc));
    return 126;
  }
  rc = posix_spawnattr_setsigmask(&attrs, &previous);
  if (rc != 0) {
    fprintf(stderr, "ccmux-launcher: posix_spawnattr_setsigmask: %s\\n", strerror(rc));
    posix_spawnattr_destroy(&attrs);
    return 126;
  }
  rc = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSIGMASK);
  if (rc != 0) {
    fprintf(stderr, "ccmux-launcher: posix_spawnattr_setflags: %s\\n", strerror(rc));
    posix_spawnattr_destroy(&attrs);
    return 126;
  }

  pid_t pid = 0;
  int failure = posix_spawnp(&pid, argv[1], NULL, &attrs, &argv[1], environ);
  posix_spawnattr_destroy(&attrs);
  if (failure != 0) {
    fprintf(stderr, "ccmux-launcher: cannot start %s: %s\\n", argv[1], strerror(failure));
    return 127;
  }

  child_pid = pid;
  if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0) {
    fprintf(stderr, "ccmux-launcher: sigprocmask(SIG_SETMASK): %s\\n", strerror(errno));
    return 126;
  }

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) {
      child_pid = 0;
      fprintf(stderr, "ccmux-launcher: waitpid: %s\\n", strerror(errno));
      return 126;
    }
  }
  child_pid = 0;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
`;
