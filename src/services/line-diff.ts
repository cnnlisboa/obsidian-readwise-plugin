const MAX_LINES = 2000;

/**
 * Line diff for previews: changed lines prefixed with "-" or "+", a few unchanged lines of context,
 * and "…" between distant changes. Returns an empty string when the texts are equal.
 */
export function diffLines(before: string, after: string, context = 2): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return `(${a.length} lines → ${b.length} lines; too large to show)`;
  // Longest common subsequence table, filled from the end
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: { kind: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i++] });
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ kind: '-', line: a[i++] });
    else ops.push({ kind: '+', line: b[j++] });
  }
  const keep = ops.map((op, index) => op.kind !== ' ' ||
    ops.slice(Math.max(0, index - context), index + context + 1).some((near) => near.kind !== ' '));
  const out: string[] = [];
  ops.forEach((op, index) => {
    if (keep[index]) out.push(`${op.kind} ${op.line}`);
    else if (keep[index - 1]) out.push('…');
  });
  return out.join('\n');
}
