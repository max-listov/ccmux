import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTailLines, readTailUntil } from "../src/util/readLines.ts";

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

/** A line cap bounds nothing when records are huge — this is the shape that made the fleet view
 *  read gigabytes to show a model name. 40 lines × 256KB = 10MB, asked for 2000 lines. */
function hugeLineFile(count: number, lineBytes: number): { path: string; lines: string[] } {
  const lines = Array.from({ length: count }, (_, i) => `${i}:${"x".repeat(lineBytes)}`);
  return { path: tmpFile(`${lines.join("\n")}\n`), lines };
}

test("byte budget caps a window whose LINE cap alone would read the whole file", () => {
  const { path, lines } = hugeLineFile(40, 256 * 1024);
  // Asking for every line but budgeting 1MB may only span the last few records.
  const tail = readTailLines(path, 2000, 1024 * 1024);
  expect(tail.length).toBeLessThan(10);
  expect(tail.length).toBeGreaterThan(0);
  // Whatever came back is the END of the file, and each record is intact.
  expect(tail[tail.length - 1]).toBe(lines[39]);
  expect(tail.every((l) => /^\d+:x+$/.test(l))).toBe(true);
});

test("byte budget never yields a partial record", () => {
  const { path } = hugeLineFile(20, 300 * 1024);
  // A budget smaller than ONE record cannot produce a whole line, so it yields none —
  // never a truncated one that a caller would try to JSON.parse.
  expect(readTailLines(path, 2000, 64 * 1024)).toEqual([]);
});

test("readTailUntil stops at the first budget that answers", () => {
  const { path, lines } = hugeLineFile(40, 256 * 1024);
  const widths: number[] = [];
  const tail = readTailUntil(
    path,
    2000,
    (ls) => {
      widths.push(ls.length);
      return ls.length > 0; // the first rung already answers
    },
    [1024 * 1024, 16 * 1024 * 1024],
  );
  expect(widths.length).toBe(1); // never widened
  expect(tail[tail.length - 1]).toBe(lines[39]);
});

test("readTailUntil widens while the fact is missing, then gives up at the ceiling", () => {
  const { path } = hugeLineFile(40, 256 * 1024);
  let asked = 0;
  const tail = readTailUntil(
    path,
    2000,
    () => {
      asked++;
      return false; // never satisfied
    },
    [1024 * 1024, 4 * 1024 * 1024],
  );
  expect(asked).toBe(2); // both rungs tried
  // It stopped at the ceiling rather than walking back through all 10MB.
  expect(tail.length).toBeLessThan(20);
});

test("readTailUntil stops once the window already spans the file", () => {
  const p = tmpFile("a\nb\nc\n");
  let asked = 0;
  readTailUntil(p, 10, () => {
    asked++;
    return false;
  }, [1024 * 1024, 4 * 1024 * 1024]);
  // The first rung already covers the whole file; widening could not reveal more.
  expect(asked).toBe(1);
});
