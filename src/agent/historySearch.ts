/** The scope and outcome of looking for a conversation outside its expected path. */
export interface HistorySearch {
  found: string | null;
  /** Every projects root attempted, including roots that do not exist yet. */
  roots: string[];
  /** A failed read is unknown history, not evidence that a conversation is absent. */
  failures: { path: string; reason: string }[];
}
