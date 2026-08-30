import { COMMANDS } from './help.ts';

// Shell completion scripts, GENERATED from the COMMANDS registry — one source, so a new/renamed verb
// can never drift from what `ccmux help` shows (the same defect class the single-source usage line
// closed). Install per shell (see README): e.g. `ccmux completions zsh > "${fpath[1]}/_ccmux"`.

export type Shell = 'bash' | 'zsh' | 'fish';

const VERBS = COMMANDS.map((c) => c.verb);
/** zsh/fish carry a per-verb description; strip the chars their describe-syntax treats specially. */
const cleanDesc = (d: string): string =>
  d.replace(/['`]/g, '').replace(/:/g, ' ').split('\n')[0] ?? '';

function bash(): string {
  return `# ccmux bash completion — install: ccmux completions bash > /etc/bash_completion.d/ccmux
_ccmux() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${VERBS.join(' ')}" -- "$cur") )
  fi
}
complete -F _ccmux ccmux
`;
}

function zsh(): string {
  const cmds = COMMANDS.map((c) => `    '${c.verb}:${cleanDesc(c.desc)}'`).join('\n');
  return `#compdef ccmux
# ccmux zsh completion — install: ccmux completions zsh > "\${fpath[1]}/_ccmux" && compinit
_ccmux() {
  local -a cmds
  cmds=(
${cmds}
  )
  _describe 'ccmux command' cmds
}
_ccmux "$@"
`;
}

function fish(): string {
  const header =
    '# ccmux fish completion — install: ccmux completions fish > ~/.config/fish/completions/ccmux.fish';
  const lines = COMMANDS.map(
    (c) => `complete -c ccmux -n __fish_use_subcommand -a ${c.verb} -d '${cleanDesc(c.desc)}'`,
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
  const shell = args[0];
  if (!isShell(shell)) {
    console.error('usage: ccmux completions <bash|zsh|fish>');
    return 1;
  }
  console.log(completionsScript(shell));
  return 0;
}
