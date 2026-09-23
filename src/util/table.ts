/**
 * Rows as aligned columns, one string per printed line, header first.
 *
 * Widths come from the rows, because the cells are addresses, tasks and line numbers: a fixed column
 * that fits the header splits every real value, and a reader who has to reassemble an address by eye
 * is the reason the wrong session gets written to. The last column is free text and is not padded,
 * so a long preview costs its own length and nothing more.
 */
export function tableLines(header: string[], rows: string[][]): string[] {
  return alignedLines([header, ...rows]);
}

/** The same alignment without a header row — for rows grouped under a heading of their own. */
export function alignedLines(rows: string[][]): string[] {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const width = Array.from({ length: columns }, (_, column) =>
    Math.max(0, ...rows.map((row) => (row[column] ?? '').length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(width[column] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}
