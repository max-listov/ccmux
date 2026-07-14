import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTailLines } from "../src/util/readLines.ts";

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-tail-"));
  const p = join(dir, "t.jsonl");
  writeFileSync(p, content);
  return p;
}

test("small file (< chunk): whole file, trailing newline dropped", () => {
  const p = tmpFile("a\nb\nc\n");
  expect(readTailLines(p, 10)).toEqual(["a", "b", "c"]);
  expect(readTailLines(p, 2)).toEqual(["b", "c"]);
});

test("large file (> chunk): exact tail lines, complete (no partial first line)", () => {
  // ~2MB = 4× the 512KB chunk → the loop walks multiple windows
  const lines = Array.from({ length: 60_000 }, (_, i) => `{"n":${i},"pad":"xxxxxxxxxxxxxxxx"}`);
  const p = tmpFile(`${lines.join("\n")}\n`);
  const tail = readTailLines(p, 120);
  expect(tail.length).toBe(120);
  expect(tail[0]).toBe(lines[59_880]);
  expect(tail[119]).toBe(lines[59_999]);
});

test("multibyte chars survive chunk borders", () => {
  // Cyrillic = 2 bytes/char in UTF-8 → some 512KB border is guaranteed to land mid-char;
  // decode-once over the joined buffer must yield zero replacement chars.
  const lines = Array.from({ length: 40_000 }, (_, i) => `строка-${i}-проверка`);
  const p = tmpFile(`${lines.join("\n")}\n`);
  const tail = readTailLines(p, 50);
  expect(tail.length).toBe(50);
  expect(tail[49]).toBe(lines[39_999]);
  expect(tail.every((l) => !l.includes("�"))).toBe(true);
});

test("missing file → [] (no throw)", () => {
  expect(readTailLines("/nonexistent/ccmux/x.jsonl", 10)).toEqual([]);
});
