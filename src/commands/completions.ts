import { parseFlags } from './flags.ts';
import { COMMANDS } from './help.ts';

// Shell completion scripts, GENERATED from the COMMANDS registry — one source, so a new/renamed verb
// can never drift from what `stitchmux help` shows (the same defect class the single-source usage line
// closed). Install per shell (see README): e.g. `stitchmux completions zsh > "${fpath[1]}/_stitchmux"`.

export type Shell = 'bash' | 'zsh' | 'fish';

const VERBS = COMMANDS.map((c) => c.verb);
/** zsh/fish carry a per-verb description; strip the chars their describe-syntax treats specially. */
const cleanDesc = (d: string): string =>
  d.replace(/['`]/g, '').replace(/:/g, ' ').split('\n')[0] ?? '';

function bash(): string {
  return `# stitchmux bash completion — install: stitchmux completions bash > /etc/bash_completion.d/stitchmux
_stitchmux() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${VERBS.join(' ')}" -- "$cur") )
  fi
}
complete -F _stitchmux stitchmux
`;
}

function zsh(): string {
  const cmds = COMMANDS.map((c) => `    '${c.verb}:${cleanDesc(c.desc)}'`).join('\n');
  return `#compdef stitchmux
# stitchmux zsh completion — install: stitchmux completions zsh > "\${fpath[1]}/_stitchmux" && compinit
_stitchmux() {
  local -a cmds
  cmds=(
${cmds}
  )
  _describe 'stitchmux command' cmds
}
_stitchmux "$@"
`;
}

function fish(): string {
  const header =
    '# stitchmux fish completion — install: stitchmux completions fish > ~/.config/fish/completions/stitchmux.fish';
  const lines = COMMANDS.map(
    (c) => `complete -c stitchmux -n __fish_use_subcommand -a ${c.verb} -d '${cleanDesc(c.desc)}'`,
  );
  return `${header}\n${lines.join('\n')}\n`;
}

export function completionsScript(shell: Shell): string {
  switch (shell) {
    case 'bash':
      return bash();
    case 'zsh':
      return zsh();
    case 'fish':
      return fish();
  }
}

const SHELLS: readonly Shell[] = ['bash', 'zsh', 'fish'];
const isShell = (s: string | undefined): s is Shell =>
  s !== undefined && (SHELLS as readonly string[]).includes(s);

export function cmdCompletions(args: string[]): number {
  const shell = parseFlags('completions', args, [1, 1]).positionals[0];
  if (!isShell(shell)) {
    console.error('usage: stitchmux completions <bash|zsh|fish>');
    return 1;
  }
  console.log(completionsScript(shell));
  return 0;
}
