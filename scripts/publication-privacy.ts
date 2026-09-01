export type PublicationFinding = { line: number; rule: string };

/**
 * A reference to this project's private working repository.
 *
 * What is forbidden is the repository ADDRESS — `<owner>/<name>` — and not the name on its own,
 * because the name on its own is public here: `ccmux-dev` is the launcher that runs the CLI from
 * source, and it appears legitimately in the README and the architecture notes. A rule that
 * forbade the bare name would fail on documentation that is correct, and a rule that fails on
 * correct documentation is switched off within a day.
 *
 * Composed at read time rather than written out, so the check knows the address it is looking for
 * without this repository containing it as a literal.
 */
const companion = (): RegExp => {
  const self = 'ccmu' + 'x';
  // The owner segment is what separates a repository address from a file path: `bin/ccmux-dev` is
  // the launcher on disk and belongs here, `<owner>/ccmux-dev` is the companion and does not. The
  // owner is this project's own, already public in the install URL.
  return new RegExp(`\\bmax-listov/${self}-dev(?![\\w-])`, 'i');
};

/**
 * An address of the form `<word>:<word>` handed to a ccmux command.
 *
 * A fleet address names a machine and a session, and both halves are private. This shape slipped
 * past every rule above — it is not a path, not a frontmatter field, not a machine label — and
 * reached a committed document naming a real machine and a real project. Placeholders survive
 * because they carry a hyphen: `host-b:agent-a` is how an example is written here.
 */
const fleetAddress = /\bccmux\s+\w[\w-]*\s+(?!(?:host|agent|machine)-)([a-z0-9]+):([a-z0-9-]+)\b/i;

/** Structural checks supplement review; arbitrary private prose cannot be inferred reliably. */
export function scanPublicationText(text: string): PublicationFinding[] {
  const findings: PublicationFinding[] = [];
  const forbiddenCompanion = companion();
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
    if (forbiddenCompanion.test(line))
      findings.push({ line: index + 1, rule: 'private-companion-repository' });
    if (fleetAddress.test(line)) findings.push({ line: index + 1, rule: 'fleet-address' });
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
