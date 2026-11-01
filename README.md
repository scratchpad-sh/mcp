# Scratchpad MCP server

**Give your AI your notes.** An [MCP](https://modelcontextprotocol.io) server for
[Scratchpad](https://scratchpad.sh/ai/), so Claude, Cursor, Codex, and any other
MCP client can search, read, write, and organize the notes you already keep.

It is small on purpose: about 2,000 lines of TypeScript, no database, and no state
on disk. Every tool is one or two calls to Scratchpad's HTTPS API, so you can read
the whole thing in an evening and know exactly what your assistant can do.

## Two ways to connect

### Remote (recommended)

No install. Point your client at the hosted server and sign in with OAuth. This is
the only way that works on a phone.

```
https://app.scratchpad.sh/api/mcp
```

Claude Code:

```sh
claude mcp add --transport http --scope user scratchpad https://app.scratchpad.sh/api/mcp
```

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "scratchpad": { "url": "https://app.scratchpad.sh/api/mcp" }
  }
}
```

### Local (stdio)

For a client that only speaks stdio, or if you would rather hold an API token than
an OAuth session. Create a token in Scratchpad under Settings, API tokens.

```json
{
  "mcpServers": {
    "scratchpad": {
      "command": "npx",
      "args": ["-y", "@scratchpadsh/mcp"],
      "env": { "SCRATCHPAD_TOKEN": "scr_your_token" }
    }
  }
}
```

Check the token before wiring it up:

```sh
SCRATCHPAD_TOKEN=scr_your_token npx -y @scratchpadsh/mcp --check
```

| Variable | | |
| --- | --- | --- |
| `SCRATCHPAD_TOKEN` | required | `read` can search and read. `full` is needed for anything that writes. |
| `SCRATCHPAD_URL` | optional | Defaults to `https://app.scratchpad.sh`. |

## Tools

| Area | Tools |
| --- | --- |
| Find and read | `search_notes`, `read_note`, `list_notes`, `list_folders` |
| Attachments | `search_attachment`, `read_attachment` |
| Write | `create_note`, `append_to_note`, `propose_edit`, `apply_edit` |
| Organize | `move_note`, `rename_note`, `archive_note`, `pin_note`, `duplicate_note` |
| Folders | `create_folder`, `rename_folder`, `move_folder`, `delete_folder` |
| History | `list_versions`, `read_version`, `restore_version` |

Every name carries a `scratchpad_` prefix, so the tools sit cleanly beside other
servers in one session.

## Built so a model cannot quietly wreck your notes

- **There is no tool that deletes a note.** That stays a job for you.
- **Editing is two steps.** `propose_edit` writes nothing: it returns a diff and an
  id. `apply_edit` takes that id and no content, so the text cannot change between
  showing you the diff and writing it.
- **Edits check the base.** If the note changed since the proposal, the edit is
  refused rather than overwriting what you typed.
- **Every edit is reversible.** History keeps earlier versions, and
  `restore_version` keeps the current one first.
- **Password-locked notes stay invisible,** to tokens and connectors alike.
- **Tools are annotated,** so a client can run reads freely and stop to show you
  each write.

## Develop

```sh
npm install
npm test
```

## License

MIT. See [LICENSE](LICENSE).

Made by [Scratchpad](https://scratchpad.sh), the notes app your AI can actually read.
More at [scratchpad.sh/ai](https://scratchpad.sh/ai/).
