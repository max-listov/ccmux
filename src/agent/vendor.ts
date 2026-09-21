/**
 * Who MADE the model, drawn as one cell.
 *
 * The runtime column already says which harness holds the session (claude / codex / opencode);
 * it does not say whose model is answering, and with OpenCode and Custom recipes those two came
 * apart — an `opencode` row can be DeepSeek, Gemini or Qwen. The mark is the missing half, and it
 * is a MARK rather than a word because the row is one line: a glyph in the vendor's own colour
 * reads at a glance and costs two columns.
 *
 * Detection is a TRANSFORM over the model id, like `prettyModel` beside it, not a catalogue: a
 * family that ships next week (`claude-mythos-6`, `gpt-6`) must resolve with no code change.
 * An OpenRouter-style `vendor/model` id answers from its own prefix. What we cannot recognise
 * gets NO mark and still gets the cell, so a column of mixed vendors stays aligned.
 */

export type ModelVendor = 'anthropic' | 'openai' | 'deepseek' | 'google';

export interface VendorMark {
  /** One terminal cell. Never an emoji: those are two cells wide and shift every column after. */
  glyph: string;
  /** Brand colour as the vendor publishes it, or a terminal colour name. */
  color: string;
  label: string;
}

const MARKS: Record<ModelVendor, VendorMark> = {
  anthropic: { glyph: '✳', color: '#D97757', label: 'Anthropic' },
  // White, not the old green: on both terminal themes it reads as the mark of the model, and the
  // green sat too close to the status colours this row already uses.
  openai: { glyph: '✻', color: 'white', label: 'OpenAI' },
  deepseek: { glyph: '≋', color: '#4D6BFE', label: 'DeepSeek' },
  google: { glyph: '✦', color: '#4285F4', label: 'Google' },
};

/** The cell every model column reserves, so rows with an unknown vendor still line up. */
export const VENDOR_CELL = ' ';

const BY_PREFIX: Record<string, ModelVendor> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  'openai-chat': 'openai',
  deepseek: 'deepseek',
  google: 'google',
  'google-vertex': 'google',
  gemini: 'google',
};

/** Families that identify their maker on their own, with no vendor prefix in the id. */
function familyVendor(family: string): ModelVendor | null {
  if (/^(claude|opus|sonnet|haiku|fable)/.test(family)) return 'anthropic';
  if (/^(gpt|chatgpt|codex|o\d)/.test(family)) return 'openai';
  if (family.startsWith('deepseek')) return 'deepseek';
  if (family.startsWith('gemini')) return 'google';
  return null;
}

/** The maker of `id`, or null when the id does not say — never a guess from the runtime. */
export function modelVendor(id: string | null): ModelVendor | null {
  if (id === null) return null;
  const bare = id.trim().toLowerCase();
  if (bare === '') return null;
  const slash = bare.indexOf('/');
  if (slash > 0) {
    const prefix = BY_PREFIX[bare.slice(0, slash)];
    if (prefix !== undefined) return prefix;
    return familyVendor(bare.slice(slash + 1));
  }
  return familyVendor(bare);
}

export function vendorMark(id: string | null): VendorMark | null {
  const vendor = modelVendor(id);
  return vendor === null ? null : MARKS[vendor];
}

/** The mark as plain text for the colourless surfaces (`ccmux list`, `ccmux fleet`, statusline). */
export function vendorGlyph(id: string | null): string {
  return vendorMark(id)?.glyph ?? VENDOR_CELL;
}
