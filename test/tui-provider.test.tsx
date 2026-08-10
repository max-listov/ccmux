import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type Intent } from "../src/tui/App.tsx";
import { makeMachine } from "./helpers.ts";

test("TUI Tab selects Codex and emits an explicit provider in the create intent", async () => {
  const tmuxBin = Bun.which("tmux");
  if (!tmuxBin) throw new Error("tmux is required for the TUI integration test");
  let resolveIntent: ((intent: Intent) => void) | undefined;
  const intent = new Promise<Intent>((resolve) => {
    resolveIntent = resolve;
  });
  const screen = render(
    <App
      m={makeMachine({ stateDir: `/tmp/ccmux-tui-provider-${process.pid}`, tmuxBin, tmuxSocket: `ccmux-tui-provider-${process.pid}` })}
      initialFullscreen={false}
      onIntent={(value) => resolveIntent?.(value)}
    />,
  );

  screen.stdin.write("n");
  await Bun.sleep(10);
  expect(screen.lastFrame()).toContain("provider: claude");
  screen.stdin.write("\t");
  await Bun.sleep(10);
  expect(screen.lastFrame()).toContain("provider: codex");
  screen.stdin.write("agent-tui");
  await Bun.sleep(10);
  screen.stdin.write("\r");

  await expect(intent).resolves.toEqual({
    type: "new",
    name: "agent-tui",
    dir: process.cwd(),
    agent: "codex",
  });
  screen.unmount();
});
