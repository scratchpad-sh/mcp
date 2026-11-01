/**
 * Line and word diffs: History's comparison of two versions
 * and the unified diff the MCP server shows before an edit is applied
 * (src/mcp-tools).
 *
 * A longest-common-subsequence table rather than Myers: notes are small, the
 * table is simple enough to trust at a glance, and anything past
 * DIFF_CELL_LIMIT cells is refused rather than built.
 */

/** Above this the quadratic table is not worth building. Notes are far smaller. */
export const DIFF_CELL_LIMIT = 4_000_000;

export type Op = { kind: " " | "-" | "+"; line: string };

export function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i * (m + 1) + j] is the length of the longest common subsequence of
  // a[i..] and b[j..]. Filled backwards so the walk below can go forwards.
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      ops.push({ kind: "-", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] });
  while (j < m) ops.push({ kind: "+", line: b[j++] });
  return ops;
}

export type DiffPart = { kind: "same" | "del" | "add"; text: string };

export type DiffRow =
  | { kind: "same" | "del" | "add"; text: string }
  /** One line edited in place, word by word. */
  | { kind: "change"; parts: DiffPart[] }
  /** Unchanged lines folded away. */
  | { kind: "gap"; lines: number };

export type Comparison = { rows: DiffRow[]; added: number; removed: number; tooLarge: boolean };

/** Words and the spaces between them, each its own token, so the spacing survives. */
function tokens(line: string): string[] {
  return line.split(/(\s+)/).filter((t) => t !== "");
}

/**
 * One line against another, word by word. Null when the two share too little
 * for marked words to read better than two whole lines, or are too long.
 */
export function diffWords(before: string, after: string): DiffPart[] | null {
  const a = tokens(before);
  const b = tokens(after);
  if ((a.length + 1) * (b.length + 1) > 40_000) return null;
  const ops = diffOps(a, b);
  const words = (list: string[]) => list.filter((t) => t.trim() !== "").length;
  const kept = ops.filter((o) => o.kind === " " && o.line.trim() !== "").length;
  // Mostly rewritten: two whole lines say that better than a scatter of marks.
  if (kept === 0 || kept < 0.4 * Math.max(words(a), words(b))) return null;
  const parts: DiffPart[] = [];
  for (const o of ops) {
    const kind = o.kind === " " ? "same" : o.kind === "-" ? "del" : "add";
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += o.line;
    else parts.push({ kind, text: o.line });
  }
  return parts;
}

/**
 * What changed from `before` to `after`, line by line, for reading: a run of
 * removed lines is paired in order with the added lines after it, and a pair
 * close enough to be one line edited reads as that line with its words marked.
 * Unchanged lines more than `context` away from a change fold into a gap.
 */
export function compareText(before: string, after: string, context = 2): Comparison {
  const a = before.split("\n");
  const b = after.split("\n");
  if ((a.length + 1) * (b.length + 1) > DIFF_CELL_LIMIT) {
    return { rows: [], added: 0, removed: 0, tooLarge: true };
  }
  const ops = diffOps(a, b);
  const added = ops.filter((o) => o.kind === "+").length;
  const removed = ops.filter((o) => o.kind === "-").length;
  if (added === 0 && removed === 0) return { rows: [], added, removed, tooLarge: false };

  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === " ") {
      rows.push({ kind: "same", text: ops[i].line });
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < ops.length && ops[i].kind === "-") dels.push(ops[i++].line);
    while (i < ops.length && ops[i].kind === "+") adds.push(ops[i++].line);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const parts = diffWords(dels[k], adds[k]);
      if (parts) rows.push({ kind: "change", parts });
      else rows.push({ kind: "del", text: dels[k] }, { kind: "add", text: adds[k] });
    }
    for (const line of dels.slice(pairs)) rows.push({ kind: "del", text: line });
    for (const line of adds.slice(pairs)) rows.push({ kind: "add", text: line });
  }

  const shown = rows.map(() => false);
  rows.forEach((row, idx) => {
    if (row.kind === "same") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) shown[k] = true;
  });
  const out: DiffRow[] = [];
  let hidden = 0;
  rows.forEach((row, idx) => {
    if (!shown[idx]) {
      hidden++;
      return;
    }
    if (hidden > 0) out.push({ kind: "gap", lines: hidden });
    hidden = 0;
    out.push(row);
  });
  if (hidden > 0) out.push({ kind: "gap", lines: hidden });
  return { rows: out, added, removed, tooLarge: false };
}
