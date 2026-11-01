/**
 * A long note, read a part at a time.
 *
 * read_note used to hand a model the first 40,000 characters and a line saying
 * it was cut, with no way to ask for the rest. Course notes can run to
 * several chapters, and asked about chapters 3 and 4 the assistant could only
 * say the tool stopped halfway through chapter 2. Now a read takes a `start`, and a note too long for one
 * reply ends by saying where the next part begins and where each heading is,
 * so the model can go straight to the chapter it was asked about.
 *
 * Offsets are positions in the note's Markdown as the tools see it, the same
 * string every call, so a heading's number from one read is where the next
 * read begins. Deliberately free of imports, like lib/tools, so the MCP server
 * bundles it without the app and the tests reach it alone.
 */

/** About what one reply can carry comfortably, and what read_note gave before. */
export const NOTE_PAGE_CHARS = 40_000;

/** Headings listed in the map at most, so the map cannot become a page itself. */
const MAX_OUTLINE = 150;

export type Heading = { at: number; level: number; text: string };

/**
 * Every Markdown heading in the note and where its line starts.
 *
 * Code fences are skipped, since a `#` there is a comment or a shell prompt,
 * not a chapter.
 */
export function headingsOf(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of md.split("\n")) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      if (fence === null) fence = opener[1][0];
      else if (opener[1][0] === fence) fence = null;
    } else if (fence === null) {
      // A closing run of # follows a space; one written with a backslash before it is the heading's own.
      const h = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      if (h) out.push({ at, level: h[1].length, text: h[2].replace(/\\(#+)$/, "$1") });
    }
    at += line.length + 1;
  }
  return out;
}

/**
 * The part of `md` that begins at `start`, with directions to the rest.
 *
 * A part ends at a line break where one falls in its second half, so a
 * sentence is not cut in two and the next part starts on a fresh line. The
 * whole note, when it fits, comes back exactly as it is, with nothing added.
 *
 * `again` is the call that reads the next part, since a version in History is
 * paged too and read_note would read the note as it stands instead.
 */
export function notePage(md: string, start = 0, size = NOTE_PAGE_CHARS, again = "call read_note again with"): string {
  const total = md.length;
  const from = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0;
  if (from === 0 && total <= size) return md;
  if (from >= total) {
    return `The note is ${total} characters long, so there is nothing at ${from}. Start from 0, or from one of the headings:\n${outline(md)}`;
  }

  let to = Math.min(total, from + size);
  if (to < total) {
    const lineEnd = md.lastIndexOf("\n", to);
    if (lineEnd > from + size / 2) to = lineEnd + 1;
  }

  const where =
    to < total
      ? `[Characters ${from} to ${to} of ${total}. The note continues: ${again} start ${to} for the next part, or with the start of a heading below to go straight to it.]`
      : `[Characters ${from} to ${to} of ${total}: this is the end of the note.]`;
  return `${md.slice(from, to).trimEnd()}\n\n${where}\n\nHeadings in this note, each with its start:\n${outline(md)}`;
}

function outline(md: string): string {
  const all = headingsOf(md);
  if (all.length === 0) return "(none: use the start numbers above)";
  // A long note with many small headings keeps its chapters and loses the leaves.
  let shown = all;
  for (let level = 6; shown.length > MAX_OUTLINE && level > 1; level--) {
    shown = shown.filter((h) => h.level < level);
  }
  shown = shown.slice(0, MAX_OUTLINE);
  const lines = shown.map((h) => `${"  ".repeat(h.level - 1)}- start ${h.at}: ${h.text}`);
  if (shown.length < all.length) lines.push(`(${all.length - shown.length} smaller headings not listed)`);
  return lines.join("\n");
}
