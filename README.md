# Copper CRM MCP Server

[![CI](https://github.com/OfirOhan/copper-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OfirOhan/copper-mcp/actions/workflows/ci.yml)
![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[Copper](https://www.copper.com)**, the CRM for Google Workspace. It lets Claude, Cursor, ChatGPT and other AI agents search contacts and companies, review the pipeline, move deals between stages, and log notes and tasks.

> **Unofficial.** This is a community project and is not affiliated with Copper. It was built from Copper's public Developer API docs.

## What you can ask your agent

- "Give me a pipeline review: open deals closing this quarter, by stage, with total value."
- "Which open deals haven't changed stage since September?"
- "Move the Acme renewal to Proposal, set the close date to Nov 30, and add a note that I sent the revised quote."
- "Who at Globex is in the CRM, and when did we last talk to them?"
- "What tasks are overdue for me? Create a follow-up task for Dana for Friday."
- "Show me the last 10 activities on the Initech deal."

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `get_account_info` | Account, API user, and all users with IDs | No |
| `search_people` | Contacts by name, email, company, tags, owner, location, last contact | No |
| `find_person_by_email` | One contact by exact email | No |
| `search_companies` | Companies by name, tags, owner, location | No |
| `list_pipelines` | Pipelines with stage IDs, names and win probability | No |
| `search_opportunities` | Deals by status, pipeline, stage, owner, value, close date, staleness. **Returns totals by status and stage** | No |
| `get_opportunity` | One deal with all fields | No |
| `create_opportunity` | Create a deal | Yes |
| `update_opportunity` | Move stage, mark Won/Lost, change value, close date or owner | Yes |
| `search_tasks` | Tasks by owner, status, due date, deal | No |
| `create_task` | Create a task linked to a record | Yes |
| `complete_task` | Mark a task Completed | Yes |
| `log_activity` | Add a note (or call, meeting...) to a record | Yes |
| `list_activities` | Activity feed for a record or date range, or the activity types | No |

The server does the translation an LLM would otherwise get wrong. It accepts ISO dates and converts them to Copper's unix-second timestamps (and `M/D/YYYY` close dates), maps `Open/Won/Lost/Abandoned` to Copper's status IDs, swaps stage IDs for stage names, and returns compact records instead of full API payloads (use `raw: true` when you want everything). Write tools carry MCP annotations, so clients can ask before running them.

## Setup

1. In Copper, go to **Settings > API Keys** and generate a key.
2. Build it:

```bash
git clone https://github.com/OfirOhan/copper-mcp.git
cd copper-mcp && npm install && npm run build
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "copper": {
      "command": "node",
      "args": ["/absolute/path/to/copper-mcp/dist/index.js"],
      "env": { "COPPER_API_KEY": "...", "COPPER_USER_EMAIL": "you@company.com" }
    }
  }
}
```

### Claude Code / Cursor / other MCP clients

```bash
claude mcp add copper -e COPPER_API_KEY=... -e COPPER_USER_EMAIL=you@company.com -- node /path/to/copper-mcp/dist/index.js
```

For Cursor and other clients, use the same command with the variables in the environment.

| Variable | Default | Notes |
|---|---|---|
| `COPPER_API_KEY` | (required) | API key from Settings > API Keys |
| `COPPER_USER_EMAIL` | (required) | Email of the user who generated the key |
| `COPPER_BASE_URL` | `https://api.copper.com/developer_api/v1` | Override for testing |

## Development

```bash
npm install
npm test   # builds, runs unit tests and an end-to-end MCP stdio test against a fake Copper API
```

The tests run on Node 20, 22 and 24 in CI.

## Author

Built by [Ofir Ohana](https://github.com/OfirOhan), an AI agents engineer. Issues and PRs are welcome.

## License

MIT
