# MCP server

Lets Claude Desktop, Claude Code, or any MCP client drive dispatch data. It
defines no tools and makes no security decisions — every tool, permission check,
tenancy guarantee and audit row comes from `src/agent/`. This is an adapter.

Local **stdio** only, for now. Remote HTTP is Phase 4b and needs the OAuth work
in the blueprint's §07; stdio skips all of it.

## Running it

```bash
cd backend
MCP_USER_EMAIL=you@example.com MCP_USER_PASSWORD=... npm run mcp
```

Claude Desktop (`claude_desktop_config.json`) or Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "epicit-dispatch": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/absolute/path/to/EpicIT-Dispatch/backend",
      "env": {
        "MCP_USER_EMAIL": "you@example.com",
        "MCP_USER_PASSWORD": "...",
        "MCP_WRITES_ENABLED": "false"
      }
    }
  }
}
```

The process reads `backend/.env` for `DATABASE_URL` and everything else, so only
the MCP-specific variables need to be in the client config.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_USER_EMAIL` / `MCP_USER_PASSWORD` | — | The account this server acts as. Required. |
| `MCP_WRITES_ENABLED` | `false` | Advertise write tools at all. |
| `MCP_ALLOW_GATED_WRITES` | `false` | Let approval-gated tools run. Requires the above. |
| `MCP_DEBUG` | `false` | Print a stack trace on startup failure. |

### Why credentials in a config file

The server runs on your machine, in this repo, against the same database — it
already has `DATABASE_URL`. The password check is not guarding the data; anyone
who can start the process could read the tables directly. What it establishes is
*identity*: which user, which organization, and therefore which permissions get
intersected with the agent ceiling. That is why this is acceptable here and would
not be over a network, where the OAuth server does the job instead.

### The two write switches

`MCP_WRITES_ENABLED` decides whether write tools are advertised.
`MCP_ALLOW_GATED_WRITES` decides whether the ones that normally stop for a human
may run.

They are separate because "may prepare a draft for me to review" and "may move a
visit without this server seeing an approval" are different amounts of trust.

Turning the second one on is a statement that **your MCP client asks first**.
Claude Desktop and Claude Code do prompt before running a tool, and that prompt
is a real human decision — but it belongs to the client, and this server cannot
verify that any given client shows one. Hence: off unless you say otherwise.

With it off, `propose_draft` and `add_job_note` still work; scheduling tools
return `APPROVAL_REQUIRED`, and the in-app assistant panel is where those get
approved.

## Known limitation: no live push

A change made through this server does **not** push to dispatchers with the app
open — they see it on their next refetch. Controllers emit real-time updates via
Socket.io, and this process has no Socket.io server; `noopSocket.ts` installs a
no-op so a committed write is not reported as a failure. Cross-process emission
would need a Socket.io Redis adapter, which is a bigger change than this
transport justifies.

That file is also worth reading before running any other tool out-of-process:
several controllers call `getSocket().emit()` unguarded after a successful
write, which is harmless inside the HTTP server and actively misleading outside
it.

## stdout belongs to the protocol

`stdio.ts` writes diagnostics to **stderr** only. A stray `console.log` anywhere
in the import graph corrupts the JSON-RPC stream, and the client reports a parse
error rather than whatever was logged.

## Testing it by hand

`src/mcp/__tests__/server.test.ts` drives a real client/server pair over the
SDK's in-memory transport. For an end-to-end check against a live database, the
MCP Inspector is the usual tool:

```bash
npx @modelcontextprotocol/inspector npm --prefix backend run mcp
```
