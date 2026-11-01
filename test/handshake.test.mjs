import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the server starts over stdio and lists its tools", async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.mjs"],
      env: { ...process.env, SCRATCHPAD_TOKEN: "scr_not_a_real_token" },
    }),
  );
  const { tools } = await client.listTools();
  assert.ok(tools.length > 10);
  assert.ok(tools.every((t) => t.name.startsWith("scratchpad_")));
  assert.ok(tools.some((t) => t.name === "scratchpad_search_notes"));
  assert.equal(client.getServerVersion().name, "scratchpad-mcp-server");
  await client.close();
});
