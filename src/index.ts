#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASE_URL, CopperClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  const apiKey = process.env.COPPER_API_KEY ?? "";
  const userEmail = process.env.COPPER_USER_EMAIL ?? "";
  if (!apiKey || !userEmail) {
    console.error(
      "copper-mcp: set COPPER_API_KEY and COPPER_USER_EMAIL (the email of the user who created the key). Create a key in Copper under Settings > API Keys.",
    );
    process.exit(1);
  }
  const baseUrl = process.env.COPPER_BASE_URL ?? BASE_URL;
  const server = createServer(new CopperClient({ apiKey, userEmail, baseUrl }));
  await server.connect(new StdioServerTransport());
  console.error(`copper-mcp running (${baseUrl})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
