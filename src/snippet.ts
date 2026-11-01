/**
 * Search snippet markers, shared by the server that produces them and the
 * browser that renders them.
 *
 * Kept in its own module with no imports: lib/notes.ts pulls in better-sqlite3,
 * and the command palette is a client component, so importing these from there
 * would drag the database driver into the browser bundle.
 *
 * Control characters rather than <mark> tags, because a snippet is note content
 * and has to reach the UI as plain text. Angle brackets would either render as
 * a literal "<mark>" or, if injected as HTML, hand any note author a scripting
 * primitive. These two cannot occur in note text, so splitting is unambiguous.
 */
export const MARK_OPEN = String.fromCharCode(2);
export const MARK_CLOSE = String.fromCharCode(3);

/** Split an FTS snippet into runs, flagging the ones that matched. */
export function splitSnippet(snippet: string): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (const chunk of snippet.split(MARK_OPEN)) {
    const [first, ...rest] = chunk.split(MARK_CLOSE);
    if (parts.length === 0 && rest.length === 0) {
      // Text before the first match.
      if (first) parts.push({ text: first, hit: false });
      continue;
    }
    if (first) parts.push({ text: first, hit: rest.length > 0 });
    const tail = rest.join(MARK_CLOSE);
    if (tail) parts.push({ text: tail, hit: false });
  }
  return parts;
}

/** The same text with the match markers removed. */
export function plainSnippet(snippet: string): string {
  return snippet.split(MARK_OPEN).join("").split(MARK_CLOSE).join("");
}
