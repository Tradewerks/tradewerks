#!/usr/bin/env node
/**
 * Entry point for the local MCP server.
 *
 * Runs on stdio, which means one hard rule: **nothing may write to stdout except
 * the protocol**. A stray console.log corrupts the JSON-RPC stream and the client
 * sees a parse error rather than a message about whatever was logged. Everything
 * diagnostic below goes to stderr, which MCP clients surface in their logs.
 *
 * Start it with:
 *   npm run mcp
 *
 * and see src/mcp/README.md for the Claude Desktop / Claude Code configuration.
 */

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "../agent/index.js"; // registers the tool catalog
import { authenticateFromEnv, McpAuthError } from "./auth.js";
import { installNoopSocket } from "./noopSocket.js";
import { createMcpServer, MCP_SERVER_INFO, policyFromEnv, visibleTools } from "./server.js";

/** stderr, never stdout — stdout belongs to the protocol. */
const note = (message: string) => process.stderr.write(`${message}\n`);

async function main(): Promise<void> {
	// Before anything can run a tool. Controllers emit real-time updates after a
	// write and mostly do it unguarded; without this, a committed change is
	// reported back as a failure. See noopSocket.ts.
	installNoopSocket();

	const ctx = await authenticateFromEnv();
	const { policy, allowGatedWrites } = policyFromEnv();
	const options = { ctx, policy, allowGatedWrites };
	const tools = visibleTools(options);

	note(`${MCP_SERVER_INFO.name} ${MCP_SERVER_INFO.version}`);
	note(`  acting as: ${ctx.userName ?? ctx.userId} (${ctx.role})`);
	note(`  organization: ${ctx.organizationId}`);
	note(`  mode: ${policy.allowWrites ? "read + write" : "read-only"}`);
	if (policy.allowWrites) {
		note(
			allowGatedWrites
				? "  gated writes: enabled — this server trusts your MCP client to ask before running a tool"
				: "  gated writes: disabled — scheduling changes will be refused (set MCP_ALLOW_GATED_WRITES=true to allow)",
		);
	}
	note(`  tools: ${tools.length}${tools.length ? ` (${tools.map((t) => t.name).join(", ")})` : ""}`);
	if (policy.allowWrites) {
		note("  note: changes made here do not live-push to open browsers; dispatchers see them on refresh");
	}

	if (!tools.length) {
		note("");
		note("That account's permissions do not reach any tool. Nothing would be callable.");
		process.exit(1);
	}

	const server = createMcpServer(options);
	await server.connect(new StdioServerTransport());
	note("  ready");
}

main().catch((err) => {
	// A failure here happens before a client is listening, so make it legible to
	// the person reading the log rather than dumping a stack.
	if (err instanceof McpAuthError) {
		note(`Could not start: ${err.message}`);
	} else {
		note(`Could not start: ${err instanceof Error ? err.message : String(err)}`);
		if (process.env.MCP_DEBUG === "true" && err instanceof Error && err.stack) note(err.stack);
	}
	process.exit(1);
});
