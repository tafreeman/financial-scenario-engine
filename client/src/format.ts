/** Format a number as a dollar string: "$1,234" */
export function fmt(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

/** Format a number as a signed dollar delta: "+$1,234" or "-$1,234" */
export function fmtDelta(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return sign + fmt(n);
}

/** Format a number as a signed percentage delta: "+3.2%" or "-1.5%" */
export function fmtPctDelta(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/** Return a Tailwind color class based on whether the delta is positive/negative */
export function deltaColor(n: number, invertPositive = false): string {
  if (n === 0) return "text-steel-500";
  const isGood = invertPositive ? n < 0 : n > 0;
  return isGood ? "text-emerald-600" : "text-red-600";
}
