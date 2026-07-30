import { test, expect } from "bun:test";
import { completionsScript } from "../src/commands/completions.ts";
import { COMMANDS } from "../src/commands/help.ts";

const VERBS = COMMANDS.map((c) => c.verb);

test("every shell script lists EVERY command verb — generated from one registry, can't drift", () => {
  for (const shell of ["bash", "zsh", "fish"] as const) {
    const script = completionsScript(shell);
    for (const v of VERBS) expect(script).toContain(v);
  }
});

test("bash uses compgen -W with the verb list", () => {
  const s = completionsScript("bash");
  expect(s).toContain("complete -F _ccmux ccmux");
  expect(s).toContain("compgen -W");
});

test("zsh is a #compdef with per-verb descriptions and no describe-breaking colons in them", () => {
  const s = completionsScript("zsh");
  expect(s.startsWith("#compdef ccmux")).toBe(true);
  // each entry is 'verb:desc' — a stray colon inside desc would split it, so desc must be colon-free
  for (const line of s.split("\n").filter((l) => l.trim().startsWith("'"))) {
    const body = line.trim().replace(/^'/, "").replace(/'$/, "");
    expect(body.split(":").length).toBe(2);
  }
});

test("fish emits one subcommand completion per verb", () => {
  const s = completionsScript("fish");
  for (const v of VERBS) expect(s).toContain(`-a ${v} `);
});
