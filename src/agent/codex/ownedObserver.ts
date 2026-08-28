import { z } from "zod";
import type { CodexAppRpc } from "./rpc.ts";
import { OwnedCodexProjection } from "./ownedProjection.ts";

const TurnsPage = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(256), status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
})).max(1) });

/** Native resume reconciles the last turn once; steady-state reads contain no transcript items. */
export async function restoreOwnedTurn(rpc: CodexAppRpc, projection: OwnedCodexProjection, threadId: string): Promise<void> {
  const revision = projection.revision;
  const page = TurnsPage.parse(await rpc.request("thread/turns/list", {
    threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
  }));
  if (revision !== projection.revision) return;
  const turn = page.data[0];
  projection.restoreTurn(turn === undefined ? null : { ...turn, startedAt: null });
}
