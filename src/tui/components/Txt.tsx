import { Text } from "ink";
import type { ReactNode } from "react";

/**
 * Text wrapper that OMITS undefined style props. Ink's `color` is a non-nullable type,
 * and with exactOptionalPropertyTypes `color={undefined}` is a type error — so every
 * view would need ternaries on raw <Text>. This keeps them clean and DRY.
 */
export function Txt({ color, dim, bold, italic, children }: { color?: string | undefined; dim?: boolean | undefined; bold?: boolean | undefined; italic?: boolean | undefined; children: ReactNode }) {
  const props: { color?: string; dimColor?: boolean; bold?: boolean; italic?: boolean } = {};
  if (color !== undefined) props.color = color;
  if (dim) props.dimColor = true;
  if (bold) props.bold = true;
  if (italic) props.italic = true;
  return <Text {...props}>{children}</Text>;
}
