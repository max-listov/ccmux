import { test, expect } from "bun:test";
import { resumePickerAnswer } from "../src/agent/claude/pane.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";

// A real, schema-valid config (no casts) — only `resumePicker` matters to the pure fn.
const base = MachineConfigSchema.parse({
  claudeBin: "/bin/claude",
  tmuxBin: "/bin/tmux",
  projectsDir: "/p",
  rcPrefix: "test",
  sessionsFile: "/s",
  bootLabel: "b",
});
const cfg = (resumePicker: "full" | "summary" | "off") => ({ ...base, resumePicker });

const PICKER = [
  "  This session is 10h 4m old and 196.1k tokens.",
  "  Resuming the full session will consume a substantial portion of your usage limits.",
  "  ❯ 1. Resume from summary (recommended)",
  "    2. Resume full session as-is",
  "    3. Don't ask me again",
].join("\n");

test("full policy → option 2 (keep all context)", () => {
  expect(resumePickerAnswer(PICKER, cfg("full"))).toBe("2");
});

test("summary policy → option 1", () => {
  expect(resumePickerAnswer(PICKER, cfg("summary"))).toBe("1");
});

test("off policy → never answers (a human will)", () => {
  expect(resumePickerAnswer(PICKER, cfg("off"))).toBeNull();
});

test("no picker on screen → null", () => {
  expect(resumePickerAnswer("just a normal prompt\n❯ ", cfg("full"))).toBeNull();
});

test("reordered menu → reads the ACTUAL option number, not a hardcoded one", () => {
  const reordered = [
    "  ❯ 1. Resume full session as-is",
    "    2. Resume from summary (recommended)",
    "    3. Don't ask me again",
  ].join("\n");
  // 'full' is now option 1 here — must return "1", proving it reads the pane, not a constant.
  expect(resumePickerAnswer(reordered, cfg("full"))).toBe("1");
  expect(resumePickerAnswer(reordered, cfg("summary"))).toBe("2");
});

test("both exact option labels required — a passing mention doesn't trigger", () => {
  // A conversation that merely says "resume from summary" must NOT be mistaken for the menu.
  expect(resumePickerAnswer("we could resume from summary of the doc", cfg("full"))).toBeNull();
});
