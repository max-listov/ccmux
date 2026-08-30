import type { DiscoveredSession } from './discover.ts';
import { capabilityReasons, capabilitySummary, writerSummary } from './fleet.ts';

function mark(enabled: boolean): string {
  return enabled ? '+' : '-';
}

export function compactCapabilitySummary(ext: DiscoveredSession): string {
  const cap = ext.capabilities;
  return `I${mark(cap.inspect)} A${mark(cap.attemptAdopt)} F${mark(cap.fork)} T${mark(cap.terminateAndAdopt)} R${mark(cap.releaseAtSource)}`;
}

/** Fixed five-line external identity block used by the framed card. */
export function externalDetailLines(ext: DiscoveredSession): string[] {
  return [
    `${ext.provider}@${ext.host}`,
    `id ${ext.threadId}`,
    `cwd ${ext.dir ?? 'unknown'}`,
    `origin ${ext.origin} · storage ${ext.storage} · writer ${writerSummary(ext)}`,
    `${compactCapabilitySummary(ext)} · ${capabilityReasons(ext)}`,
  ];
}

/** Expanded evidence for the inline renderer and transcript-side identity surface. */
export function externalEvidenceText(ext: DiscoveredSession): string {
  return `${ext.provider}@${ext.host} · ${ext.threadId} · origin ${ext.origin} · storage ${ext.storage} · writer ${writerSummary(ext)} · ${capabilitySummary(ext)} · ${capabilityReasons(ext)}`;
}
