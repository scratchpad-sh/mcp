/**
 * Targeted edits to a note's Markdown, for the assistant drawer.
 *
 * propose_edit used to take only the complete new note body, so adding one
 * paragraph meant the model typing the whole note back out. On a long note that
 * ran past the reply's token cap every time, and the person got "the reply ran
 * past the length limit" however short their request was (2026-09-22, a
 * summary to be put into long reading notes, in French). With an
 * edit, the model writes only the passage it changes and the server builds the
 * full note from it, so the proposal card and Accept are unchanged.
 *
 * Deliberately free of imports, like lib/tools, so the tests can reach it alone.
 */

export type NoteEdit = { find: string; replace: string };

export type EditResult = { ok: true; markdown: string } | { ok: false; why: string };

/**
 * The edits from a tool call, or a reason they cannot be used.
 *
 * Streamed arguments that were cut off degrade to `{}` or to half an object,
 * and that must read as a broken call rather than as "no change".
 */
export function readEdits(raw: unknown): NoteEdit[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "That tool call arrived incomplete: no edits. Try again.";
  }
  const edits: NoteEdit[] = [];
  for (const item of raw) {
    const find = (item as { find?: unknown } | null)?.find;
    const replace = (item as { replace?: unknown } | null)?.replace;
    if (typeof replace !== "string" || (find !== undefined && typeof find !== "string")) {
      return "That tool call arrived incomplete: every edit needs find and replace as text. Try again.";
    }
    edits.push({ find: find ?? "", replace });
  }
  return edits;
}

/**
 * Apply edits in order, each to the result of the one before.
 *
 * An empty `find` adds `replace` at the end of the note. Otherwise `find` must
 * appear exactly once: a passage that is missing or repeated is refused with a
 * reason the model can act on, never guessed at, because a guess is a change to
 * a part of the note nobody asked about.
 */
export function applyEdits(markdown: string, edits: NoteEdit[]): EditResult {
  let out = markdown;
  for (const [i, edit] of edits.entries()) {
    const which = edits.length > 1 ? `Edit ${i + 1}: ` : "";

    if (!edit.find.trim()) {
      const added = edit.replace.trim();
      if (!added) return { ok: false, why: `${which}nothing to add: replace was empty.` };
      out = out.trim() ? `${out.trimEnd()}\n\n${added}\n` : `${added}\n`;
      continue;
    }

    // Exactly as given first, then without the blank lines a model tends to add
    // or drop at either end of a quoted passage.
    const find = count(out, edit.find) > 0 ? edit.find : edit.find.trim();
    const found = count(out, find);
    if (found === 0) {
      return {
        ok: false,
        why: `${which}the text to find is not in the note, so nothing was proposed. Copy a short passage (a line or two) exactly as it appears in the note and try again.`,
      };
    }
    if (found > 1) {
      return {
        ok: false,
        why: `${which}the text to find appears ${found} times in the note, so nothing was proposed. Include more of the surrounding text so it matches only once.`,
      };
    }
    // Split and join rather than String.replace, which would read "$1" or "$&"
    // in the new text (and a note full of LaTeX has plenty) as patterns.
    const at = out.indexOf(find);
    out = out.slice(0, at) + edit.replace + out.slice(at + find.length);
  }
  return { ok: true, markdown: out };
}

function count(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  // Overlapping matches count: "Yes\nYes" is in "Yes\nYes\nYes" twice, and was taken as unique.
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

/**
 * An edit with only its new text passed through `sweep`.
 *
 * The assistant's dash filter ran over the whole replacement, and an insert
 * repeats the passage it goes after, so the person's own dashes in that
 * passage went too. Only the part of `replace` between what it shares with
 * `find` at either end is new.
 */
export function sweepNewText(edit: NoteEdit, sweep: (text: string) => string): NoteEdit {
  const { find, replace } = edit;
  let start = 0;
  while (start < find.length && start < replace.length && find[start] === replace[start]) start++;
  let end = 0;
  while (
    end < find.length - start &&
    end < replace.length - start &&
    find[find.length - 1 - end] === replace[replace.length - 1 - end]
  ) {
    end++;
  }
  const middle = replace.slice(start, replace.length - end);
  return { find, replace: replace.slice(0, start) + sweep(middle) + replace.slice(replace.length - end) };
}

/**
 * A rewritten note with only its new lines passed through `sweep`: a line
 * already in `base` word for word is the person's, and a line inside a code
 * fence is code.
 */
export function sweepNewLines(markdown: string, base: string, sweep: (text: string) => string): string {
  const theirs = new Set(base.split("\n"));
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opens = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (opens && opens[1][0] === fence[0] && opens[1].length >= fence.length) fence = null;
        return line;
      }
      if (opens) {
        fence = opens[1];
        return line;
      }
      return theirs.has(line) ? line : sweep(line);
    })
    .join("\n");
}

/**
 * A short fingerprint of a note's Markdown, so a proposal written against one
 * version of a note can tell it is no longer that note. Not
 * for security: two texts that happened to share one would only let an Accept
 * through that the edit check would have refused.
 */
export function textFingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}:${text.length}`;
}
