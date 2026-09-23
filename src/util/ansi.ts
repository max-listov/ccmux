/** Terminal attribute sequences in captured pane text. */

/** Every ANSI colour/attribute sequence — for turning a styled capture back into plain text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal SGR sequences are intentionally matched by ESC byte.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** A dim run up to the attribute that ends it, or to the end of the line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI dim runs require the literal ESC byte.
const DIM_RUN_RE = /\u001b\[2m[\s\S]*?(?:\u001b\[(?:0|22)m|$)/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

/**
 * What a person actually typed after a composer prompt.
 *
 * A composer dims its placeholder and the completion it proposes after the typed bytes. Dropping the
 * dim RUNS, rather than asking whether the whole line is dim, is what keeps `typed<dim completion>`
 * counted as occupied while a dim placeholder alone reads as empty.
 */
export const typedText = (styled: string): string =>
  stripAnsi(styled.replace(DIM_RUN_RE, '')).trim();
