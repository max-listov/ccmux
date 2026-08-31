export type PublicationFinding = { line: number; rule: string };

/** Structural checks supplement review; arbitrary private prose cannot be inferred reliably. */
export function scanPublicationText(text: string): PublicationFinding[] {
  const findings: PublicationFinding[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const homePaths = line.matchAll(/(?:\/Users\/|\/home\/|~\/home\/)([A-Za-z0-9._-]+)\//g);
    if ([...homePaths].some((match) => match[1] !== 'u'))
      findings.push({ line: index + 1, rule: 'private-home-path' });
    if (/^\s*(responsible|target-repo|return-to|return-thread|source-thread-id)\s*:/i.test(line))
      findings.push({ line: index + 1, rule: 'operational-coordination-field' });
    if (/\b[A-Z][A-Z0-9]{1,15}-(?:DEV|PROD|MBP(?:-[A-Z0-9]+)?|LAPTOP|DESKTOP)\b/.test(line))
      findings.push({ line: index + 1, rule: 'deployment-machine-label' });
    if (
      /\b(?:return|report|reply|send)\b.*\b(?:thread|session|task)\b/i.test(line) &&
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(line)
    )
      findings.push({ line: index + 1, rule: 'private-return-route' });
  }
  return findings;
}

/** Inspect additions, not deleted historical text or the patch's file-name headers. */
export function scanPublicationPatch(patch: string): PublicationFinding[] {
  const findings: PublicationFinding[] = [];
  let lineNumber: number | null = null;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.[1] !== undefined) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (lineNumber === null) continue;
    if (line.startsWith('+')) {
      findings.push(
        ...scanPublicationText(line.slice(1)).map((finding) => ({
          ...finding,
          line: lineNumber ?? 0,
        })),
      );
      lineNumber++;
    } else if (line.startsWith(' ')) lineNumber++;
  }
  return findings;
}
