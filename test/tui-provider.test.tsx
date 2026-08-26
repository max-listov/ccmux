import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type Intent } from "../src/tui/App.tsx";
import { makeMachine } from "./helpers.ts";

async function waitForFrame(screen: ReturnType<typeof render>, needle: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!screen.lastFrame()?.includes(needle)) {
    if (Date.now() >= deadline) throw new Error(`TUI did not render ${JSON.stringify(needle)} within 1s`);
    await Bun.sleep(10);
  }
}

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
  await waitForFrame(screen, "provider: claude");
  expect(screen.lastFrame()).toContain("provider: claude");
  screen.stdin.write("\t");
  await waitForFrame(screen, "provider: codex");
  expect(screen.lastFrame()).toContain("provider: codex");
  screen.stdin.write("agent-tui");
  await waitForFrame(screen, "agent-tui");
  screen.stdin.write("\r");

  await expect(intent).resolves.toEqual({
    type: "new",
    name: "agent-tui",
    dir: process.cwd(),
    agent: "codex",
  });
  screen.unmount();
});
