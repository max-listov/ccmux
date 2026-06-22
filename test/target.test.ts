import { test, expect } from "bun:test";
import { exactTarget, paneTarget } from "../src/tmux/target.ts";

test("exact-match targets carry the leading = (prefix-collision guard)", () => {
  expect(exactTarget("cc-api")).toBe("=cc-api");
  expect(paneTarget("cc-api")).toBe("=cc-api:0.0");
});

test("=NAME cannot prefix-match a longer sibling", () => {
  // tmux treats =cc-api as exact, so it never resolves to cc-api-staging.
  expect(exactTarget("cc-api")).not.toBe(exactTarget("cc-api-staging"));
});
