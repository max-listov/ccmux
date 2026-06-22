import { test, expect } from "bun:test";
import { humanizeDuration } from "../src/util/duration.ts";

test("humanizeDuration renders compact, largest-two units", () => {
  expect(humanizeDuration(0)).toBe("—");
  expect(humanizeDuration(-5)).toBe("—");
  expect(humanizeDuration(45)).toBe("45s");
  expect(humanizeDuration(60)).toBe("1m");
  expect(humanizeDuration(185)).toBe("3m"); // sub-minute dropped below the hour
  expect(humanizeDuration(3600)).toBe("1h");
  expect(humanizeDuration(3600 + 10 * 60)).toBe("1h10m");
  expect(humanizeDuration(86400)).toBe("1d");
  expect(humanizeDuration(86400 + 3 * 3600)).toBe("1d3h");
});
