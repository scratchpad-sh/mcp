/**
 * The MCP server that runs on your machine.
 *
 * Speaks MCP over stdio to whatever started it (Claude Code, Claude Desktop),
 * and reaches the notes the same way a phone shortcut does: HTTPS to the app
 * with an API token. It holds no database handle and knows nothing about how a
 * note is stored, which is why it can sit on a laptop and talk to production.
 *
 * There is a second way in now, and for most purposes a better one: adding the
 * app to Claude as a remote connector, which is served by the route at
 * /api/mcp and works on a phone, where this cannot. Both offer the same tools,
 * because both are the same tools: everything of substance lives in
 * src/mcp-tools.ts and this file is the stdio half of the wiring.
 *
 * Setup for both is in the help centre (scratchpad.sh/docs). `npx @scratchpadsh/mcp --check` proves the
 * URL and the token.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { toolsFor } from "./tools.ts";
import {
  DEFAULT_URL,
  createScratchpadServer,
  probeBackend,
  type Backend,
} from "./mcp-tools.ts";

const BASE_URL = (process.env.SCRATCHPAD_URL || DEFAULT_URL).replace(/\/+$/, "");
const TOKEN = (process.env.SCRATCHPAD_TOKEN || "").trim();

const backend: Backend = { baseUrl: BASE_URL, token: TOKEN };

function usage(): string {
  return `scratchpad-mcp-server

  Speaks MCP over stdio and reaches a Scratchpad install over HTTPS.

  Most clients no longer need this. Adding the install as a remote connector,
  at <url>/api/mcp, offers the same tools and works on a phone too. This is
  still the way in for a client that only speaks stdio.

  SCRATCHPAD_TOKEN   required. An API token from Settings > API tokens.
                     "read" can search and read. "full" is needed to create,
                     append, and apply an edit.
  SCRATCHPAD_URL     optional. Defaults to ${DEFAULT_URL}

  --check            confirm the URL and token work, then exit
  --help             this text

  Tools: ${toolsFor("mcp").map((t) => `scratchpad_${t.name}`).join(", ")}`;
}

async function check(): Promise<void> {
  // stdout is the MCP channel, so it is only safe to print here, where the
  // process is being run by a human rather than by a client.
  console.log(`URL:   ${BASE_URL}`);
  console.log(`Token: ${TOKEN ? `${TOKEN.slice(0, 8)}... (${TOKEN.length} chars)` : "NOT SET"}`);
  const count = await probeBackend(backend);
  console.log(`OK. The token can read ${count} note${count === 1 ? "" : "s"}.`);
  console.log("A scope error here means the token is `capture`, which cannot read.");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  if (!TOKEN) {
    console.error("SCRATCHPAD_TOKEN is not set. Create a token in Settings > API tokens.");
    process.exit(1);
  }
  if (!/^https?:\/\//.test(BASE_URL)) {
    console.error(`SCRATCHPAD_URL must start with http:// or https://, got "${BASE_URL}"`);
    process.exit(1);
  }

  if (argv.includes("--check")) {
    try {
      await check();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  await createScratchpadServer(backend, BASE_URL).connect(new StdioServerTransport());
  // stderr, never stdout: stdout is the protocol.
  console.error(`scratchpad-mcp-server ready, talking to ${BASE_URL}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
