/**
 * How many processes the suite is dealt out to, by the cores this machine has free now.
 *
 * The tests wait far more than they compute, so a share per core but one is not too many — up to
 * eight: measured on eighteen cores, twelve shares made two timing-bound tests fail that eight
 * never did. But the cores are shared with whatever else runs: on the same machine with a load
 * average of 64–125 from other work, eight shares failed one or two timing-bound tests in four
 * runs of five, each time different ones, while three shares at a load of 45–56 passed all of them
 * in 145 s instead of 115–135. So the count follows the cores left over, and never drops below
 * three: fewer is slower than the failures it would prevent.
 */
export function sharesFor(cores: number, load: number): number {
  const free = Math.floor(cores - load) - 1;
  return Math.max(Math.min(3, cores), Math.min(8, free));
}
