import { Text } from "ink";
import { Txt } from "./Txt.tsx";

// "+12 −3" rendered git-style: additions green, removals red. Any other result string
// falls back to the caller's plain styling — so this is used as `diffParts(result)`
// check + <DiffStat/> render, never a silent reformat.

const DIFF_RE = /^\+(\d+) −(\d+)$/;

export function isDiffStat(result: string): boolean {
  return DIFF_RE.test(result);
}

export function DiffStat({ result }: { result: string }) {
  const mm = result.match(DIFF_RE);
  if (!mm) return <Txt dim>{result}</Txt>;
  return (
    <Text>
      <Text color="green">{`+${mm[1]}`}</Text>
      <Text> </Text>
      <Text color="red">{`−${mm[2]}`}</Text>
    </Text>
  );
}
