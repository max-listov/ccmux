import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type Intent } from "../src/tui/App.tsx";
import { makeMachine } from "./helpers.ts";

async function waitForNextFrame(screen: ReturnType<typeof render>, previousCount: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (screen.frames.length <= previousCount) {
    if (Date.now() >= deadline) throw new Error("TUI did not commit the input within 5s");
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

  let frames = screen.frames.length;
  screen.stdin.write("n");
  await waitForNextFrame(screen, frames);
  frames = screen.frames.length;
  screen.stdin.write("\t");
  await waitForNextFrame(screen, frames);
  frames = screen.frames.length;
  screen.stdin.write("agent-tui");
  await waitForNextFrame(screen, frames);
  screen.stdin.write("\r");

  await expect(intent).resolves.toEqual({
    type: "new",
    name: "agent-tui",
    dir: process.cwd(),
    agent: "codex",
  });
  screen.unmount();
});
