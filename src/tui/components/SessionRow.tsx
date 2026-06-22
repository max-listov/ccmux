import { Box } from "ink";
import { Txt } from "./Txt.tsx";
import { pad, provColor } from "../format.ts";
import { statusMark } from "../status.ts";
import type { FleetItem } from "../fleet.ts";

/** One fleet line: name + provider + model + context + uptime. The unified status is
 *  shown separately — inline as a column (showStatus), or as a frame badge (framed card). */
export function SessionRow({ item, selected, spin, showStatus = true }: { item: FleetItem; selected: boolean; spin: string; showStatus?: boolean }) {
  const { row, status, external } = item;
  const s = row.session;
  return (
    <Box>
      {showStatus ? <Txt color={status.color} bold={status.active}>{`${statusMark(status, spin)} `}</Txt> : null}
      <Txt color={external ? "magenta" : undefined} bold={selected}>{pad(s.name, 17)}</Txt>
      <Txt color={provColor(s.agent)}>{pad(s.agent, 7)}</Txt>
      <Txt>{pad(row.model ?? "—", 10)}</Txt>
      {showStatus ? <Txt color={status.color} bold={status.active}>{pad(status.label, 11)}</Txt> : null}
      <Txt dim>{`${pad(row.contextLabel, 9)} ${row.uptimeText}`}</Txt>
    </Box>
  );
}
