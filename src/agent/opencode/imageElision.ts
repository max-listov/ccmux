import { ATTACHMENT_LIMITS } from '../../attachments/reference.ts';

const PREFIXES = ['data:image/png;base64,', 'data:image/jpeg;base64,'];
const MARKER = new TextEncoder().encode('ccmux-inline-image:omitted');
const MAX_VALUE = Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4;
const MAX_DISCARDED = Math.ceil(ATTACHMENT_LIMITS.messageBytes / 3) * 4;

/** Native OpenCode echoes file bytes in JSON/SSE. Elide only literal image URL values before
 * SDK allocation; all other bytes retain the ordinary HTTP/frame budget. This is a lexical
 * projection, not a JSON parser: the SDK still validates the resulting complete native JSON.
 * Retained attachment references, not this marker, authorize preview/history access. */
export class InlineImageElider {
  private quoted = false;
  private escaped = false;
  private token = '';
  private closedToken = '';
  private valueKey = '';
  private prefix: number[] | null = null;
  private eliding = false;
  private valueBytes = 0;
  private discarded = 0;

  feed(byte: number, emit: (byte: number) => void): void {
    if (this.eliding) {
      if (byte === 34) {
        this.eliding = false;
        this.quoted = false;
        this.closedToken = '';
        emit(byte);
        return;
      }
      if (
        !(
          (byte >= 65 && byte <= 90) ||
          (byte >= 97 && byte <= 122) ||
          (byte >= 48 && byte <= 57) ||
          byte === 43 ||
          byte === 47 ||
          byte === 61
        )
      )
        throw new Error('Native inline image encoding is invalid');
      if (++this.valueBytes > MAX_VALUE || ++this.discarded > MAX_DISCARDED)
        throw new Error('Native inline image exceeds its bounded byte budget');
      return;
    }
    if (this.prefix !== null) {
      this.prefix.push(byte);
      const prefix = String.fromCharCode(...this.prefix);
      if (PREFIXES.includes(prefix)) {
        this.prefix = null;
        this.eliding = true;
        this.valueBytes = 0;
        for (const part of MARKER) emit(part);
        return;
      }
      if (PREFIXES.some((candidate) => candidate.startsWith(prefix))) return;
      const pending = this.prefix;
      this.prefix = null;
      for (const part of pending) this.ordinary(part, emit);
      return;
    }
    this.ordinary(byte, emit);
  }

  private ordinary(byte: number, emit: (byte: number) => void): void {
    emit(byte);
    if (this.quoted) {
      if (this.escaped) {
        this.escaped = false;
        this.token = '!';
        return;
      }
      if (byte === 92) {
        this.escaped = true;
        this.token = '!';
        return;
      }
      if (byte === 34) {
        this.quoted = false;
        this.closedToken = this.token;
        return;
      }
      this.token = this.token.length < 8 ? this.token + String.fromCharCode(byte) : '!';
      return;
    }
    if (byte === 34) {
      this.quoted = true;
      this.token = '';
      if (this.valueKey === 'url') this.prefix = [];
      this.valueKey = '';
    } else if (byte === 58) {
      this.valueKey = this.closedToken;
      this.closedToken = '';
    } else if (byte !== 32 && byte !== 9 && byte !== 13 && byte !== 10) {
      this.valueKey = '';
      this.closedToken = '';
    }
  }

  finish(emit: (byte: number) => void): void {
    if (this.eliding) throw new Error('Native inline image was truncated');
    if (this.prefix !== null) {
      for (const byte of this.prefix) emit(byte);
      this.prefix = null;
    }
  }
}
