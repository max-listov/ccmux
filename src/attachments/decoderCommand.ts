import { ATTACHMENT_LIMITS } from "./reference.ts";
import { validateImageBytes } from "./imageValidation.ts";
import { AttachmentFault } from "./errors.ts";

/** Hidden owner helper: bytes arrive on stdin, safe metadata leaves on stdout. */
export async function cmdValidateAttachment(): Promise<number> {
  const reader = Bun.stdin.stream().getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > ATTACHMENT_LIMITS.imageBytes) throw new Error("image-byte-budget");
      chunks.push(next.value);
    }
    const result = validateImageBytes(Buffer.concat(chunks));
    await Bun.write(Bun.stdout, JSON.stringify({ ok: true, image: result }));
    return 0;
  } catch (error) {
    const reason = error instanceof AttachmentFault ? error.reason : "image-decode-failed";
    await Bun.write(Bun.stdout, JSON.stringify({ ok: false, reason }));
    return 1;
  } finally { reader.releaseLock(); }
}
