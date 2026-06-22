import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** -1 if a < b, 0 if equal, 1 if a > b. Both must be `x.y.z`. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}
