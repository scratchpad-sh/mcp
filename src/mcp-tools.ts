/**
 * The MCP tools, once, for both servers that offer them.
 *
 * There are two ways a model reaches these notes over MCP. One is the stdio
 * server in src/index.ts, running on the machine you are working at. The
 * other is the route at /api/mcp, which is what a remote connector talks to and
 * the only one a phone can use, because claude.ai accepts remote HTTPS servers
 * and nothing else.
 *
 * They differ in exactly two values: which origin to call, and which credential
 * to present. That is the `Backend` below, and it is the whole reason this file
 * exists rather than a second copy of the handlers growing quietly out of step
 * with the first.
 *
 * The thinness is still deliberate and still worth keeping. Every tool here is
 * one or two calls to routes documented in the help centre, and the API speaks
 * Markdown in both directions, so neither server has to understand the document
 * schema. That is what lets the in-app one point at 127.0.0.1 and get the flush
 * ordering, the locked note rule, the append safety window and the scope
 * refusals for free: they live in the route files, and are written once.
 *
 * The tools come from src/tools.ts, which the in-app assistant reads too. See
 * that file for why the two surfaces differ where they do.
 *
 * EDITING AN EXISTING NOTE IS TWO STEPS, ON PURPOSE. In the app, propose_edit
 * draws a diff and a human clicks accept. There is no drawer here, so
 * propose_edit writes nothing at all: it returns a diff and an id, and
 * apply_edit takes that id and nothing else. A model cannot rewrite a note
 * without having first put the diff in front of the user, and cannot alter the
 * text between showing it and writing it, because apply_edit has no content
 * parameter to alter.
 *
 * `create_note` and `append_to_note` DO write in one call, and that is not an
 * oversight. Neither can destroy anything: one makes a new note, the other only
 * concatenates. The two-step shape exists to protect text that already exists,
 * which is why it guards the one tool that replaces it. Both declare
 * `readOnlyHint: false`, which is the annotation hosts use to stop and show the
 * call and its arguments before running it.
 *
 * The folder tools and `move_note` write in one call for the same reason: none
 * of them changes a word of any note, and what one does another can undo. The
 * one to be careful with, `delete_folder`, is held back by the route rather
 * than here, which refuses a token any folder that still has something in it.
 */
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolsFor, type ToolSpec } from "./tools.ts";
import { applyEdits, readEdits } from "./note-edits.ts";
import { notePage } from "./note-pages.ts";
import { plainSnippet } from "./snippet.ts";
import { DIFF_CELL_LIMIT, diffOps } from "./text-diff.ts";

/* --------------------------------- config --------------------------------- */

/** Where the stdio server points when SCRATCHPAD_URL says nothing. */
export const DEFAULT_URL = "https://app.scratchpad.sh";

/**
 * Which install to talk to, and as whom.
 *
 * The only thing that differs between the two servers. On a laptop this is a
 * public HTTPS origin and a scr_ token typed into a client config; inside the
 * app it is 127.0.0.1 and the OAuth access token the connector presented on the
 * request being served. Everything below is the same code either way, which is
 * the point of it being here rather than duplicated.
 */
export type Backend = {
  /** Absolute origin, no trailing slash. */
  baseUrl: string;
  /** Presented verbatim as `Authorization: Bearer`. */
  token: string;
  /**
   * Who this is, for scoping proposals. The ACCOUNT, not the credential.
   *
   * Omit it and the credential is used instead, which is right for the stdio
   * server, whose token is a scr_ one that does not change. It is wrong for a
   * connector: an OAuth access token is replaced by a new row on every refresh,
   * roughly hourly, so a proposal made before one and applied after it stopped
   * matching its owner and apply_edit blamed an hour passing or the server
   * restarting, neither of which had happened. Worse, the refresh lands between
   * propose and apply BY CONSTRUCTION, because it is the apply call's own 401
   * that triggers it.
   */
  owner?: string;
};

/** Long enough for a cold Next.js route, short enough to fail rather than hang. */
const TIMEOUT_MS = 20_000;

/** Search returns up to 50; this is what is worth putting in a transcript. */
const MAX_SEARCH_RESULTS = 25;
const MAX_LIST_RESULTS = 200;

/* ------------------------------- http client ------------------------------- */

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One call to the app, with the token attached and failures turned into
 * sentences a model can act on.
 *
 * The app's own error messages are good and specific, especially the scope
 * refusal, which names the scope the token has and what it cannot do. Those are
 * passed through rather than replaced with something generic.
 */
async function callApi(
  backend: Backend,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${backend.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${backend.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
    throw new ApiError(0, `The request to ${backend.baseUrl} ${reason}. Is the app reachable from here?`);
  }

  if (res.ok) return res;

  // Errors are JSON, {"error": "..."}, per the API contract. A proxy failing in
  // front of the app is the case where they are not.
  let detail = "";
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
      detail = (body as { error: string }).error;
    }
  } catch {
    /* not JSON; the status carries what there is to say */
  }

  switch (res.status) {
    case 401:
      throw new ApiError(401, detail || "The credential was rejected. It may have been revoked, or SCRATCHPAD_TOKEN may be wrong.");
    case 403:
      // Usually the scope refusal, which already explains itself precisely.
      throw new ApiError(403, detail || "Refused. The token's scope does not cover this.");
    case 404:
      throw new ApiError(404, detail || "Not found. Check the note id, and note that a locked note is invisible here.");
    case 429:
      throw new ApiError(429, "Rate limited: this token is capped at 60 requests a minute. Wait a moment.");
    default:
      throw new ApiError(res.status, detail || `The app answered ${res.status}.`);
  }
}

/**
 * Confirm a backend answers, and say how much the credential can see.
 *
 * Behind `--check`, which is the one thing a person runs by hand before
 * trusting a client config. Counting notes rather than pinging something
 * trivial is deliberate: it proves the credential as well as the URL, and a
 * `capture` token fails here with the scope message, which is the answer.
 */
export async function probeBackend(backend: Backend): Promise<number> {
  const res = await callApi(backend, "/api/notes");
  const { notes } = (await res.json()) as { notes: unknown[] };
  return notes.length;
}

/* --------------------------------- shapes --------------------------------- */

type NoteStub = {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: number;
  locked: boolean;
  pinned?: boolean;
};

/* A row of a note's History, as the versions route sends it. */
type VersionRow = {
  id: string;
  title: string;
  author_label: string;
  reason: string;
  char_delta: number;
  created_at: number;
  size: number;
};

/*
 * `file` is set when the match came from INSIDE an attachment rather than from
 * the note's own words (lib/attachment-search). It was being dropped here, so a
 * passage out of a PDF arrived looking like note body, and the read_note that
 * followed contained no such sentence: the app appeared to contradict itself.
 */
type SearchHit = { id: string; title: string; snippet: string; updatedAt: number; file?: string; locked?: boolean };

/*
 * A folder as the API sends it, which is the database row: snake_case, and
 * `parent_id` null at the top level.
 */
type Folder = { id: string; name: string; parent_id?: string | null };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function when(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/* To the minute, for History, where several versions share a day. */
function whenExactly(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/* An optional true/false argument, with the default the tool describes. */
function flag(args: Args, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

/*
 * gateNote refuses a locked note to every token before reading anything, and
 * "Note is locked" alone reads as though unlocking were an option. Over a
 * connector it is not: unlocking is something a browser does.
 */
function lockedRefusal(err: unknown, doing: string): string | null {
  if (err instanceof ApiError && err.status === 403 && /locked/i.test(err.message)) {
    return `That note is password-locked, so it cannot be ${doing} from here. The user can do it in the app.`;
  }
  return null;
}

/* ---------------------------------- diff ---------------------------------- */

/**
 * A unified diff, because the point of proposing is that someone reads it.
 *
 * Written here rather than pulled in: this is the one thing the MCP server does
 * that the app has no equivalent of (the drawer renders its diff in the DOM),
 * and a line diff with context is fifty lines of well understood code.
 */
const DIFF_CONTEXT = 3;

// The line diff itself lives in lib/text-diff, which History's comparison uses too.
function unifiedDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");

  if (before === after) return "(no change: the proposed text is identical to the note)";
  if ((a.length + 1) * (b.length + 1) > DIFF_CELL_LIMIT) {
    return `(too large to diff line by line: ${a.length} lines before, ${b.length} lines after)`;
  }

  const ops = diffOps(a, b);

  /*
   * Keep only the changed runs and DIFF_CONTEXT lines either side. A note is
   * mostly unchanged text, and printing all of it buries the edit.
   */
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, idx - DIFF_CONTEXT); k <= Math.min(ops.length - 1, idx + DIFF_CONTEXT); k++) {
      keep[k] = true;
    }
  });

  const out: string[] = [];
  let skipping = false;
  ops.forEach((op, idx) => {
    if (keep[idx]) {
      if (skipping) out.push("...");
      skipping = false;
      out.push(`${op.kind}${op.line}`);
    } else {
      skipping = true;
    }
  });
  if (skipping) out.push("...");
  return out.join("\n");
}

/* ------------------------------- proposals -------------------------------- */

type Proposal = {
  noteId: string;
  title: string;
  summary: string;
  markdown: string;
  /*
   * A hash of the note as it read when the diff was drawn, not the note.
   *
   * It is only ever compared for equality, never shown and never diffed again,
   * so the text itself buys nothing and costs a second full copy of the note
   * for the whole hour. It is also the only part of a proposal NOT bounded by
   * the MCP route's 1 MB request cap: `markdown` arrived in the request and is
   * capped by it, while this came back from the API and is as big as the note.
   *
   * See applyEdit, which hashes the current note and compares.
   */
  baseHash: string;
  at: number;
  /**
   * Which credential proposed it. Checked on apply so an id cannot be carried
   * from one account to another, back when both share this process.
   *
   * Belt and braces: applying someone else's proposal would fail at the API's
   * own access check anyway, and a four byte id is not guessable. It costs one
   * string compare to not have to rely on either.
   */
  owner: string;
};

/*
 * Held in this process only, and lost on restart. That is the right lifetime: a
 * proposal is a step in a conversation, and one still sitting here tomorrow is
 * one nobody accepted. Nothing is written down, so an abandoned proposal leaves
 * no trace in the account at all.
 */
const globalForProposals = globalThis as unknown as { __mcpProposals?: Map<string, Proposal> };
const proposals = globalForProposals.__mcpProposals ?? new Map<string, Proposal>();
/*
 * Held across Next's dev module reloading, which re-evaluates this file between
 * two calls in the same conversation and would otherwise drop every proposal
 * the moment anything on disk changed. Same trick, and same reason, as the
 * database connection in lib/db.
 */
if (process.env.NODE_ENV !== "production") globalForProposals.__mcpProposals = proposals;

/** A proposal, only if this caller is the one that made it. */
function ownedProposal(id: string, owner: string): Proposal | undefined {
  const held = proposals.get(id);
  return held && held.owner === owner ? held : undefined;
}

/**
 * A stable, opaque name for a credential.
 *
 * Hashed rather than stored: this ends up on every live proposal, and a token
 * sitting in memory next to the note it is about to write is worth not having.
 */
function ownerKey(backend: Backend): string {
  /*
   * The account when there is one, and never a constant: keying on anything
   * shared would let one account's proposal id resolve for another, and the
   * refusals below echo the note's TITLE back before any API call could refuse
   * it. A blank or missing owner falls through to the credential rather than
   * collapsing to one value.
   */
  const identity =
    typeof backend.owner === "string" && backend.owner.trim() ? `user:${backend.owner}` : backend.token;
  return crypto.createHash("sha256").update(`${backend.baseUrl}\n${identity}`).digest("hex").slice(0, 16);
}
/*
 * Identity of a note's text, for telling "unchanged" from "changed underneath".
 *
 * sha256 and not a cheaper digest because a collision here means silently
 * discarding somebody's edit: apply_edit would decide the note had not moved
 * and overwrite the version that did.
 */
function hashOf(markdown: string): string {
  return crypto.createHash("sha256").update(markdown).digest("hex");
}

const PROPOSAL_TTL_MS = 60 * 60 * 1000;

/** Live proposals kept at once for one owner. Each holds one copy of the proposed body. */
const MAX_PROPOSALS = 32;
/** And for everyone together, since the hosted app serves every account from one process. */
const MAX_PROPOSALS_ALL = 128;

/** The oldest entry among those `keep` admits. */
function oldestProposal(keep: (held: Proposal) => boolean): string | undefined {
  let oldest: [string, Proposal] | undefined;
  for (const entry of proposals) if (keep(entry[1]) && (!oldest || entry[1].at < oldest[1].at)) oldest = entry;
  return oldest?.[0];
}

function rememberProposal(p: Proposal): string {
  const cutoff = Date.now() - PROPOSAL_TTL_MS;
  for (const [id, held] of proposals) if (held.at < cutoff) proposals.delete(id);
  /*
   * And a ceiling on the live ones, because the sweep above only drops EXPIRED
   * entries. A model looping on propose_edit held every attempt for the full
   * hour, in a process that does not restart.
   *
   * This is a cap on ENTRIES, not on bytes, so the arithmetic is worth stating
   * rather than asserting a total. What a proposal retains is the proposed
   * `markdown`, which arrived in a request and so is bounded by the MCP route's
   * MAX_BODY_BYTES of 1 MB, plus a title, a summary and two hashes. So the
   * ceiling here is what makes the whole map bounded: 32 entries of at most
   * about a megabyte, per owner, and 128 of them in all.
   *
   * It reads worse than it is. A megabyte of markdown is an enormous note, and
   * reaching the cap needs 32 live proposals inside one hour. The number that
   * used to be unbounded was the base copy, and that is a hash now.
   *
   * The cap is per owner because one ceiling for the whole map let one
   * account's 32 proposals evict another account's before it was applied. When
   * the map as a whole is full, the entry to go is the oldest of whoever holds
   * the most, so no one account can push out anybody else's.
   */
  for (;;) {
    const mine = [...proposals.values()].filter((held) => held.owner === p.owner).length;
    if (mine < MAX_PROPOSALS) break;
    const oldest = oldestProposal((held) => held.owner === p.owner);
    if (!oldest) break;
    proposals.delete(oldest);
  }
  while (proposals.size >= MAX_PROPOSALS_ALL) {
    const held = new Map<string, number>();
    for (const { owner } of proposals.values()) held.set(owner, (held.get(owner) ?? 0) + 1);
    const most = Math.max(...held.values());
    const oldest = oldestProposal((entry) => held.get(entry.owner) === most);
    if (!oldest) break;
    proposals.delete(oldest);
  }
  const id = `p_${crypto.randomBytes(4).toString("hex")}`;
  proposals.set(id, p);
  return id;
}

/* --------------------------------- tools ---------------------------------- */

/*
 * Zod has already validated these as strings, but zodShape builds its shape at
 * runtime from src/tools.ts, so the concrete type is not something the compiler
 * can recover. Reading them defensively costs a typeof and means a schema
 * change can never turn into a silent undefined halfway through a handler.
 */
type Args = Record<string, unknown>;

/** A string argument, trimmed. Absent, blank and wrongly typed all read alike. */
function str(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The same, untrimmed: note bodies own their leading and trailing whitespace. */
function raw(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/**
 * Every tool, bound to one install and one credential.
 *
 * Built per caller rather than once at module scope, because the in-app server
 * serves a different connector on every request and they must not share a
 * client. The handler bodies below are the same ones the stdio server has
 * always run; only what they reach is a parameter now.
 */
export function buildHandlers(backend: Backend): Record<string, (args: Args) => Promise<string>> {
  const api = (path: string, init?: { method?: string; body?: unknown }) => callApi(backend, path, init);

  const apiJson = async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> =>
    (await api(path, init)).json() as Promise<T>;

  /**
   * Read a note as Markdown. Flushes the live document first, so it is current.
   *
   * `attachments=list` asks the export to append what the note has attached and
   * how long each one is. One request, not two: the first version of this made
   * a second call per note, which doubled the traffic for every read and, in
   * the connector tests, hit a stub that never answered.
   */
  const noteMarkdown = async (noteId: string): Promise<string> =>
    (
      await api(`/api/notes/${encodeURIComponent(noteId)}/export?format=md&attachments=list`)
    ).text();

  /*
   * The note alone, for proposing and applying. The attachment list above is
   * a description for the reader, not part of the note: an edit composed
   * against it could find a passage in it that the note does not have, and a
   * whole body copied from a read would write the list into the note.
   */
  const noteBody = async (noteId: string): Promise<string> =>
    (await api(`/api/notes/${encodeURIComponent(noteId)}/export?format=md`)).text();

  const owner = ownerKey(backend);

  const HANDLERS: Record<string, (args: Args) => Promise<string>> = {
    async search_notes(args) {
      const query = str(args, "query");
      if (!query) return "Nothing to search for: query was empty.";
      // A locked note found by its name cannot be read over a token, so it is no answer here.
      const results = (
        await apiJson<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}`)
      ).results.filter((r) => !r.locked);
      if (results.length === 0) return `No notes matched "${query}".`;

      const shown = results.slice(0, MAX_SEARCH_RESULTS);
      const lines = shown.map(
        (r) =>
          `- id: ${r.id}\n  title: ${r.title}\n  updated: ${when(r.updatedAt)}\n` +
          (r.file ? `  in file: ${r.file}\n` : "") +
          `  match: ${plainSnippet(r.snippet)}`,
      );
      if (results.length > shown.length) {
        lines.push(`\nShowing ${shown.length} of ${results.length} matches. Narrow the query to see fewer.`);
      }
      return lines.join("\n");
    },

    async read_note(args) {
      const id = str(args, "note_id");
      if (!id) return "note_id is required.";
      const md = await noteMarkdown(id);

      /*
       * WHAT THE NOTE HAS ATTACHED, APPENDED TO WHAT IT SAYS.
       *
       * A file renders in the Markdown as `[contract.pdf](/api/uploads/abc)`,
       * which to a model on the other end of a connector is a link it cannot
       * follow to bytes it could not read. Asked to summarise a folder, it read
       * the filename as though it were the contents.
       *
       * So the note's files are listed here, with how long each one is, and the
       * next step is named. The text itself is NOT inlined: a folder of notes
       * each carrying a 300-page PDF is millions of characters, and the caller
       * asked for a note. read_attachment fetches the pages actually wanted.
       */
      if (!md.trim()) return "That note is empty.";
      // A long note in parts, each ending with where the rest is (lib/note-pages).
      return notePage(md, Number(args.start ?? 0));
    },

    async search_attachment(args) {
      const id = str(args, "note_id");
      const file = str(args, "file");
      const query = str(args, "query");
      if (!id) return "note_id is required: say which note the file is attached to.";
      if (!file) return "file is required.";
      if (!query) return "query is required.";
      const { text } = await apiJson<{ text: string }>(
        `/api/notes/${encodeURIComponent(id)}/attachments?file=${encodeURIComponent(file)}&q=${encodeURIComponent(query)}`,
      );
      return text;
    },

    async read_attachment(args) {
      const id = str(args, "note_id");
      const file = str(args, "file");
      if (!id) return "note_id is required: say which note the file is attached to.";
      if (!file) return "file is required.";
      const from = str(args, "from_page") || String(args.from_page ?? "");
      const to = str(args, "to_page") || String(args.to_page ?? "");
      const params = new URLSearchParams({ file });
      if (from) params.set("from", from);
      if (to && to !== "undefined") params.set("to", to);
      const { text } = await apiJson<{ text: string }>(
        `/api/notes/${encodeURIComponent(id)}/attachments?${params.toString()}`,
      );
      return text;
    },

    async list_notes(args) {
      const params = new URLSearchParams();
      const folder = str(args, "folder_id");
      const archived = flag(args, "archived", false);
      if (folder) params.set("folder", folder);
      if (archived) params.set("archived", "1");
      const query = params.toString();
      const { notes, folders } = await apiJson<{ notes: NoteStub[]; folders: Folder[] }>(
        `/api/notes${query ? `?${query}` : ""}`,
      );
      if (notes.length === 0) {
        return archived ? "There are no archived notes." : folder ? "No notes are filed in that folder." : "There are no notes yet.";
      }

      const folderName = new Map(folders.map((f) => [f.id, f.name]));
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
      const shown = notes.slice(offset, offset + MAX_LIST_RESULTS);
      if (shown.length === 0) return `There are ${notes.length} notes, so there is nothing at offset ${offset}.`;
      const lines = shown.map((n) => {
        /*
         * The folder's id beside its name, because a name is not an address:
         * "2024" can sit under Taxes and under Invoices at once, and move_note
         * needs to know which.
         */
        const where = n.folderId
          ? ` [${folderName.get(n.folderId) ?? "unknown folder"}, folder ${n.folderId}]`
          : "";
        return `- ${n.id}  ${n.title}${where}  (updated ${when(n.updatedAt)})${n.pinned ? "  PINNED" : ""}${n.locked ? "  LOCKED" : ""}`;
      });
      if (notes.length > shown.length) {
        const next = offset + shown.length;
        lines.push(
          `\nShowing ${offset + 1} to ${next} of ${notes.length}.` +
            (next < notes.length ? ` Call list_notes with offset ${next} for more, or use search_notes to find a particular one.` : ""),
        );
      }
      return lines.join("\n");
    },

    async create_note(args) {
      const markdown = str(args, "markdown");
      if (!markdown) return "markdown is required: a note with nothing in it is not worth creating.";
      const folderId = str(args, "folder_id");
      const { id } = await apiJson<{ id: string }>("/api/notes", {
        method: "POST",
        body: { markdown, ...(folderId ? { folderId } : {}) },
      });
      return `Created note ${id}. Its title is the first line.`;
    },

    /**
     * The folders as a tree, each with its id and how many notes it holds.
     *
     * From the sidebar's own payload rather than /api/folders, because that one
     * request carries both the tree and the notes to count, and it is what the
     * app draws the rail from, so the two cannot disagree. Archived notes are
     * asked for as well and counted apart: they still live in their folder,
     * and delete_folder refuses a folder that holds one, so a count that left
     * them out told the assistant "0 notes" about a folder it was then refused
     * for.
     */
    async list_folders() {
      const [{ notes, folders }, { notes: archived }] = await Promise.all([
        apiJson<{ notes: NoteStub[]; folders: Folder[] }>("/api/notes"),
        apiJson<{ notes: NoteStub[] }>("/api/notes?archived=1"),
      ]);
      const counts = new Map<string, number>();
      const shelved = new Map<string, number>();
      let unfiled = 0;
      for (const n of notes) {
        if (n.folderId) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);
        else unfiled++;
      }
      for (const n of archived) {
        if (n.folderId) shelved.set(n.folderId, (shelved.get(n.folderId) ?? 0) + 1);
      }
      const uncategorized = `Uncategorized: ${plural(unfiled, "note", "notes")} in no folder.`;
      if (folders.length === 0) return `There are no folders yet.\n\n${uncategorized}`;

      // Already in the rail's order (pinned, then hand-set), so each level keeps it.
      const known = new Set(folders.map((f) => f.id));
      const kids = new Map<string | null, Folder[]>();
      for (const f of folders) {
        const parent = f.parent_id && known.has(f.parent_id) ? f.parent_id : null;
        kids.set(parent, [...(kids.get(parent) ?? []), f]);
      }
      const lines: string[] = [];
      const seen = new Set<string>();
      const walk = (parent: string | null, depth: number) => {
        for (const f of kids.get(parent) ?? []) {
          // The server refuses to write a cycle; this refuses to loop on one.
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          const n = counts.get(f.id) ?? 0;
          const a = shelved.get(f.id) ?? 0;
          const held = a > 0 ? `${plural(n, "note", "notes")}, ${a} archived` : plural(n, "note", "notes");
          lines.push(`${"  ".repeat(depth)}- ${f.name}  (id: ${f.id}, ${held})`);
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      lines.push("", uncategorized);
      return lines.join("\n");
    },

    async move_note(args) {
      const id = str(args, "note_id");
      if (!id) return "note_id is required.";
      const folderId = str(args, "folder_id");
      try {
        const { title } = await apiJson<{ title: string }>(`/api/notes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          // null is Uncategorized. An empty string would be too, but say it plainly.
          body: { folderId: folderId || null },
        });
        return folderId
          ? `Moved "${title}" into folder ${folderId}. Nothing inside the note changed.`
          : `Took "${title}" out of its folder. It is in Uncategorized now.`;
      } catch (err) {
        const refusal = lockedRefusal(err, "moved");
        if (refusal) return refusal;
        throw err;
      }
    },

    async rename_note(args) {
      const id = str(args, "note_id");
      if (!id) return "note_id is required.";
      if (typeof args.title !== "string") return "title is required: the new name, or an empty string for the automatic one.";
      const title = str(args, "title");
      try {
        const renamed = await apiJson<{ title: string }>(`/api/notes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { title },
        });
        return title
          ? `Renamed the note to "${renamed.title}". Nothing inside it changed.`
          : `The note is named after its first line again: "${renamed.title}".`;
      } catch (err) {
        const refusal = lockedRefusal(err, "renamed");
        if (refusal) return refusal;
        throw err;
      }
    },

    async archive_note(args) {
      const id = str(args, "note_id");
      if (!id) return "note_id is required.";
      const archived = flag(args, "archived", true);
      try {
        const { title } = await apiJson<{ title: string }>(`/api/notes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { archived },
        });
        return archived
          ? `Archived "${title}". It is out of the list but kept whole and still found by search; archive_note with archived false brings it back.`
          : `Brought "${title}" back from the archive.`;
      } catch (err) {
        const refusal = lockedRefusal(err, archived ? "archived" : "brought back");
        if (refusal) return refusal;
        throw err;
      }
    },

    async pin_note(args) {
      const id = str(args, "note_id");
      if (!id) return "note_id is required.";
      const pinned = flag(args, "pinned", true);
      try {
        const { title } = await apiJson<{ title: string }>(`/api/notes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { pinned },
        });
        return pinned ? `Pinned "${title}" to the top of the list.` : `Unpinned "${title}".`;
      } catch (err) {
        const refusal = lockedRefusal(err, pinned ? "pinned" : "unpinned");
        if (refusal) return refusal;
        throw err;
      }
    },

    async duplicate_note(args) {
      const id = str(args, "note_id");
      if (!id) return "note_id is required.";
      const { id: copy } = await apiJson<{ id: string }>(`/api/notes/${encodeURIComponent(id)}/duplicate`, {
        method: "POST",
      });
      return `Made a copy with id ${copy}, in the same folder. The original is unchanged.`;
    },

    async list_versions(args) {
      const id = str(args, "note_id");
      if (!id) return "note_id is required.";
      const { versions } = await apiJson<{ versions: VersionRow[] }>(
        `/api/notes/${encodeURIComponent(id)}/versions`,
      );
      if (versions.length === 0) return "This note has no History yet.";
      return versions
        .map(
          (v) =>
            `- ${v.id}  ${whenExactly(v.created_at)}  ${v.reason} by ${v.author_label}  ` +
            `(${v.size} characters, ${v.char_delta >= 0 ? "+" : ""}${v.char_delta})  "${v.title}"`,
        )
        .join("\n");
    },

    async read_version(args) {
      const id = str(args, "note_id");
      const versionId = str(args, "version_id");
      if (!id) return "note_id is required.";
      if (!versionId) return "version_id is required: list_versions gives them.";
      const v = await apiJson<{ title: string; createdAt: number; authorLabel: string; reason: string; markdown: string }>(
        `/api/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
      );
      const head = `Version ${versionId} of "${v.title}", saved ${whenExactly(v.createdAt)} (${v.reason} by ${v.authorLabel}). This is History, not the note as it stands.`;
      return `${head}\n\n${v.markdown.trim() ? notePage(v.markdown, Number(args.start ?? 0), undefined, `call read_version again with version_id ${versionId} and`) : "(this version was empty)"}`;
    },

    async restore_version(args) {
      const id = str(args, "note_id");
      const versionId = str(args, "version_id");
      if (!id) return "note_id is required.";
      if (!versionId) return "version_id is required: list_versions gives them.";
      await apiJson(`/api/notes/${encodeURIComponent(id)}/versions`, {
        method: "PUT",
        body: { versionId },
      });
      return `Restored version ${versionId}. The note as it stood just before is the newest "before-restore" version in its History, so restoring that one undoes this.`;
    },

    async create_folder(args) {
      const name = str(args, "name");
      if (!name) return "name is required.";
      const parentId = str(args, "parent_id");
      const folder = await apiJson<Folder>("/api/folders", {
        method: "POST",
        body: { name, parentId: parentId || null },
      });
      return `Created folder "${folder.name}" with id ${folder.id}, ${parentId ? `inside folder ${parentId}` : "at the top level"}.`;
    },

    async rename_folder(args) {
      const id = str(args, "folder_id");
      const name = str(args, "name");
      if (!id) return "folder_id is required.";
      if (!name) return "name is required.";
      await apiJson("/api/folders", { method: "PATCH", body: { id, name } });
      return `Renamed folder ${id} to "${name}". Its notes and sub-folders are where they were.`;
    },

    /**
     * Put a folder somewhere else, carrying its branch.
     *
     * The route only knows how to take the COMPLETE ordered list of one
     * parent's children, because that is what a drag in the rail sends: moving
     * and ordering are one write there, so a row is never parented but
     * unplaced. So the new neighbours are read first and this folder goes
     * after them, in the rail's own order, which is where a new folder lands
     * too. The depth cap and the cycle guard are the route's, and their
     * refusals come back as they are.
     */
    async move_folder(args) {
      const id = str(args, "folder_id");
      if (!id) return "folder_id is required.";
      const parentId = str(args, "parent_id") || null;
      const { folders } = await apiJson<{ folders: Folder[] }>("/api/folders");
      const moving = folders.find((f) => f.id === id);
      /*
       * Checked here because the route cannot: it ignores an id that is not
       * the caller's, so a stale client cannot reshuffle folders it never
       * knew about, and a mistyped id would come back "ok" having done nothing.
       */
      if (!moving) return `No folder with id "${id}". list_folders shows the ids.`;
      const parent = parentId === null ? null : folders.find((f) => f.id === parentId);
      if (parentId !== null && !parent) {
        return `No folder with id "${parentId}" to move it into. list_folders shows the ids.`;
      }
      if ((moving.parent_id ?? null) === parentId) {
        return `"${moving.name}" is already there. Nothing was changed.`;
      }
      const order = [
        ...folders.filter((f) => (f.parent_id ?? null) === parentId && f.id !== id).map((f) => f.id),
        id,
      ];
      await apiJson("/api/folders", { method: "PATCH", body: { parentId, order } });
      return `Moved "${moving.name}" ${parent ? `inside "${parent.name}"` : "to the top level"}, with everything in it.`;
    },

    async delete_folder(args) {
      const id = str(args, "folder_id");
      if (!id) return "folder_id is required.";
      await apiJson("/api/folders", { method: "DELETE", body: { id } });
      return "Deleted the folder. It was empty, so no note was touched.";
    },

    async append_to_note(args) {
      const id = str(args, "note_id");
      const markdown = str(args, "markdown");
      if (!id) return "note_id is required.";
      if (!markdown) return "markdown is required.";
      const { title, joinedRun } = await apiJson<{ title: string; joinedRun?: boolean }>(
        `/api/notes/${encodeURIComponent(id)}/append`,
        { method: "POST", body: { markdown } },
      );
      // Appends close together by the same caller share one version (lib/note-append).
      return joinedRun
        ? `Added to "${title}". Everything already in the note was left alone. The note as it was before this run of additions is the newest "before-append" version in its History, so restoring that one undoes all of them, this one included.`
        : `Added to "${title}". Everything already in the note was left alone, and the previous version was kept.`;
    },

    /**
     * Draw the diff. Write nothing.
     *
     * The note is read here rather than taken on trust so the diff is against
     * what is actually stored, including anything typed into the app seconds ago,
     * and so apply_edit has a baseline to check against later.
     */
    async propose_edit(args) {
      const noteId = str(args, "note_id");
      const summary = str(args, "summary");
      if (!noteId) return "note_id is required.";
      const whole = raw(args, "markdown");
      if (args.edits === undefined && !whole.trim()) {
        return "Nothing was proposed: send edits, or markdown with the whole new note.";
      }

      const base = await noteBody(noteId);
      /*
       * Edits are applied here, to the note as it is stored this moment, and
       * the result is what the diff shows and apply_edit writes, exactly as a
       * whole body would be. A passage that is missing or repeated is refused
       * by applyEdits with a reason, never guessed at.
       */
      let markdown = whole;
      if (args.edits !== undefined) {
        const edits = readEdits(args.edits);
        if (typeof edits === "string") return edits;
        const applied = applyEdits(base, edits);
        if (!applied.ok) return applied.why;
        markdown = applied.markdown;
      }
      if (base === markdown) {
        return "That is identical to the note as it stands. Nothing to propose.";
      }

      const { title } = await apiJson<{ title: string }>(`/api/notes/${encodeURIComponent(noteId)}`);
      const id = rememberProposal({
        noteId, title, summary, markdown, baseHash: hashOf(base), at: Date.now(), owner,
      });

      return [
        `Proposal ${id} for "${title}". NOTHING HAS BEEN WRITTEN.`,
        summary ? `\n${summary}` : "",
        "",
        unifiedDiff(base, markdown),
        "",
        `Show this diff to the user. If they want it, call apply_edit with proposal_id "${id}".`,
      ]
        .filter((part) => part !== "")
        .join("\n");
    },

    /**
     * Write a proposal, exactly as it was shown.
     *
     * The base check is the reason this is not simply a PATCH. A note can change
     * between proposing and applying: the user keeps typing, another session
     * writes, a phone shortcut appends. Sending the proposed body then would
     * quietly delete whatever arrived in the gap, because the body was composed
     * against an older version of the note. Refusing and asking for a fresh
     * proposal costs one round trip and cannot lose anything.
     */
    async apply_edit(args) {
      const proposalId = str(args, "proposal_id");
      if (!proposalId) return "proposal_id is required.";

      const proposal = ownedProposal(proposalId, owner);
      if (!proposal) {
        /*
       * Undifferentiated between "never existed", "not yours" and "swept",
       * matching resolveToken in lib/api-token. It also stops this asserting a
       * cause it cannot know: it used to name two, and could be wrong about
       * both.
       */
      return `No proposal with id "${proposalId}". Call propose_edit again.`;
      }
      /*
       * Checked here as well as in rememberProposal, because that sweep only runs
       * when a NEW proposal is made: a session that took one propose_edit and
       * never another kept it applicable for the life of the process, while the
       * refusal message above promised an hour. The base comparison below meant
       * a late apply could not silently discard anything, so this is about the
       * promise matching the code rather than about a hole.
       */
      if (Date.now() - proposal.at > PROPOSAL_TTL_MS) {
        proposals.delete(proposalId);
        return `That proposal for "${proposal.title}" is more than an hour old and has been dropped. Read the note again and propose a fresh edit.`;
      }

      const current = await noteBody(proposal.noteId);
      if (hashOf(current) !== proposal.baseHash) {
        proposals.delete(proposalId);
        return `"${proposal.title}" has changed since this was proposed, so applying it now would discard that change. The proposal has been dropped. Read the note again and propose a fresh edit.`;
      }

      /*
       * The base goes with the write and is checked again there: the check above is a separate request, and typing that landed
       * between it and this write was overwritten.
       */
      let keptAttachments: string[] | undefined;
      try {
        ({ keptAttachments } = await apiJson<{ keptAttachments?: string[] }>(
          `/api/notes/${encodeURIComponent(proposal.noteId)}`,
          { method: "PATCH", body: { markdown: proposal.markdown, baseHash: proposal.baseHash } },
        ));
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 412) throw err;
        proposals.delete(proposalId);
        return `"${proposal.title}" has changed since this was proposed, so applying it now would discard that change. The proposal has been dropped. Read the note again and propose a fresh edit.`;
      }
      // Single use: the note it was composed against no longer exists.
      proposals.delete(proposalId);
      /*
       * A file the proposal dropped is not removed but moved to the end (see
       * keepAttachments), so "Written" alone told the user a removal happened
       * that did not.
       */
      const kept = keptAttachments?.length
        ? ` A file cannot be removed from here, so this was kept and now sits at the end of the note: ${keptAttachments.join(", ")}. The user can delete it in the app.`
        : "";
      return `Written to "${proposal.title}". The previous version was kept, so it can be restored from the note's history.${kept}`;
    },
  };

  return HANDLERS;
}

/* ------------------------------- annotations ------------------------------- */

/*
 * Hints, not enforcement, but the ones that matter here are honest and useful.
 * propose_edit is genuinely read-only, which is what lets a client wave it
 * through while still stopping to ask about apply_edit, and that split is the
 * whole design.
 */
const ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }> = {
  search_notes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  read_note: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_notes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  create_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  append_to_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  propose_edit: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  // Replaces the body of an existing note. The one tool worth being asked about.
  apply_edit: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  // Both only ever read out of a file that is already stored, and the same call
  // twice gives the same pages back.
  search_attachment: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  read_attachment: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_folders: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  /*
   * Filing and renaming are not destructive in the sense a host cares about:
   * nothing is lost, and the same tool puts it back. Each is idempotent, since
   * a second identical call finds the note or folder already where it asked.
   */
  move_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  create_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  rename_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  move_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  // Only ever an empty folder (the route refuses anything else), but the folder,
  // and any link sharing it, is gone and no tool here brings it back.
  delete_folder: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  // Each undone by calling it again the other way; none loses anything.
  rename_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  archive_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  pin_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  duplicate_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  list_versions: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  read_version: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  /*
   * Replaces the note's text, so a host should stop and ask, even though the
   * text replaced is kept in History and can be put back.
   */
  restore_version: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

/* ------------------------------- registration ------------------------------ */

/**
 * Turn a tool's JSON Schema parameters into the Zod shape the SDK wants.
 *
 * src/tools.ts is shared with the assistant route, which hands its parameters
 * to provider APIs as JSON Schema, so that is the form they are written in.
 * Rather than keep a second Zod copy in step by hand, they are converted, and
 * anything this does not understand throws at startup instead of quietly
 * becoming an untyped argument.
 */
type JsonProp = {
  type?: string;
  description?: string;
  items?: { type?: string; properties?: Record<string, JsonProp>; required?: string[] };
};

function zodShape(spec: ToolSpec): Record<string, z.ZodTypeAny> {
  const params = spec.parameters as {
    properties?: Record<string, JsonProp>;
    required?: string[];
  };
  const required = new Set(params.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(params.properties ?? {})) {
    /*
     * `integer` arrived with the attachment tools, whose page numbers are whole
     * numbers. Its own branch rather than widening this to "number": a page and
     * a half is not a page, and the schema already says which it is. Anything
     * else still throws at startup, which is how this converter has always
     * announced a type it does not know.
     */
    let field: z.ZodTypeAny;
    if (prop.type === "string") {
      field = z.string().describe(prop.description ?? "");
    } else if (prop.type === "integer") {
      field = z.number().int().describe(prop.description ?? "");
    } else if (prop.type === "boolean") {
      field = z.boolean().describe(prop.description ?? "");
    } else if (prop.type === "array" && prop.items?.type === "object") {
      /*
       * propose_edit's edits: a list of objects of strings. Only that shape,
       * so a new kind of array still throws below rather than arriving
       * unchecked.
       */
      const item: Record<string, z.ZodTypeAny> = {};
      const inner = new Set(prop.items.required ?? []);
      for (const [key, sub] of Object.entries(prop.items.properties ?? {})) {
        if (sub.type !== "string") {
          throw new Error(`Tool ${spec.name}: "${name}.${key}" is of type "${sub.type}", which this converter does not handle.`);
        }
        const s = z.string().describe(sub.description ?? "");
        item[key] = inner.has(key) ? s : s.optional();
      }
      field = z.array(z.object(item)).describe(prop.description ?? "");
    } else {
      throw new Error(
        `Tool ${spec.name}: parameter "${name}" is of type "${prop.type}", which this converter does not handle. Teach zodShape about it in src/mcp-tools.ts.`,
      );
    }
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}

/**
 * How this server introduces itself.
 *
 * `icons` is what puts the Scratchpad mark beside the entry in Claude's
 * connectors list instead of a generic placeholder. They have to be absolute
 * URLs, and they are fetched without a credential, outside any authenticated
 * request: these three sit in public/ and are served by Next with nothing in
 * front of them, which is what makes that work.
 */
export function serverIdentity(origin: string) {
  const at = (file: string) => `${origin.replace(/\/+$/, "")}${file}`;
  return {
    name: "scratchpad-mcp-server",
    title: "Scratchpad",
    version: "1.0.0",
    description: "Personal notes, shared when you want them to be.",
    websiteUrl: origin,
    icons: [
      { src: at("/icon.svg"), mimeType: "image/svg+xml", sizes: ["any"] },
      { src: at("/icon-192.png"), mimeType: "image/png", sizes: ["192x192"] },
      { src: at("/icon-512.png"), mimeType: "image/png", sizes: ["512x512"] },
    ],
  };
}

/**
 * A server with every tool registered, talking to one install as one caller.
 *
 * Both transports call this: the stdio server hands it a public origin and a
 * scr_ token, the route in the app hands it loopback and the connector's own
 * OAuth token. Neither knows anything the other does not.
 */
export function createScratchpadServer(backend: Backend, origin: string): McpServer {
  const HANDLERS = buildHandlers(backend);
  const server = new McpServer(serverIdentity(origin));

  for (const spec of toolsFor("mcp")) {
    const handler = HANDLERS[spec.name];
    const annotations = ANNOTATIONS[spec.name];
    /*
     * A tool added to the inventory for the mcp surface and nowhere else would
     * otherwise appear in the list and fail when called. Refusing to start is the
     * loud version of that, in the same spirit as the schema check above.
     */
    if (!handler || !annotations) {
      throw new Error(`Tool "${spec.name}" is offered over MCP but has no handler in src/mcp-tools.ts.`);
    }

    server.registerTool(
      // Prefixed because this server sits alongside others in the same session,
      // and "read_note" belongs to nobody in particular.
      `scratchpad_${spec.name}`,
      {
        title: spec.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
        description: spec.description,
        inputSchema: zodShape(spec),
        annotations: { ...annotations, openWorldHint: true },
      },
      async (args: Args) => {
        try {
          return { content: [{ type: "text" as const, text: await handler(args) }] };
        } catch (err) {
          const text =
            err instanceof ApiError
              ? err.message
              : `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }
      },
    );
  }

  return server;
}
