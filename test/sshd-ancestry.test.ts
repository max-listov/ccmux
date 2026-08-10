import { test, expect } from "bun:test";
import { parseProcStat, hasSshdAncestor } from "../src/chat/auth.ts";

// This walk gates every inbound remote message. It used to shell out ONCE PER ANCESTOR, which
// measured at ~104ms per message on Linux — the most expensive step in delivery, and the only one
// priced in process spawns. Reading the tree directly brought it to ~0.1ms. These tests pin the
// parsing that made the direct read possible, since that is where the new risk lives.

test("a command containing spaces and a closing paren is still parsed correctly", () => {
  // The exact input that defeats splitting on whitespace or on the FIRST ')'. A process can be named
  // anything, and a misparse here would silently deny delivery.
  expect(parseProcStat("42 (weird ) name) S 7 7 0 0 -1 4194304 100")).toEqual({ parent: 7, command: "weird ) name" });
});

test("an ordinary line parses, and the parent is the field after the state", () => {
  expect(parseProcStat("1234 (sshd) S 991 1234 1234 0 -1 4194560 200")).toEqual({ parent: 991, command: "sshd" });
});

test("garbage yields null rather than a guessed parent", () => {
  // Fail-closed matters more here than anywhere: a guessed parent could turn "not from the transport"
  // into "accepted".
  for (const bad of ["", "no parens at all", "42 (unclosed S 7", "42 (x) S notanumber"]) {
    expect(parseProcStat(bad)).toBeNull();
  }
});

test("the walk answers with a boolean and never throws on a nonexistent process", () => {
  expect(typeof hasSshdAncestor(999_999_99)).toBe("boolean");
  expect(hasSshdAncestor(1)).toBe(false); // pid 1 has no ancestors to inspect
});
