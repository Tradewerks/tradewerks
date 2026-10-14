/**
 * The tool registry — the single catalog both transports read from.
 *
 * Registration is validated, not trusted. A tool that omits its permissions, or
 * collides with an existing name, throws at import time: the process refuses to
 * boot rather than exposing an unguarded action to a model.
 */

import type { z } from "zod";
import type { AnyToolDefinition, RiskClass, ToolDefinition } from "./types.js";
import { toolInputSchema } from "./schema.js";

const registry = new Map<string, AnyToolDefinition>();

/** Snake_case, because that is what the model sees and what audit rows store. */
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Register a tool. Call at module load; `tools/index.ts` imports every tool
 * module so that importing the registry gives you a fully populated catalog.
 *
 * Returns the definition so a module can `export const getJob = defineTool({...})`
 * for direct use in tests without going through the registry.
 */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
	if (!TOOL_NAME.test(def.name)) {
		throw new Error(`Invalid tool name "${def.name}": expected snake_case, 3-64 chars`);
	}
	if (registry.has(def.name)) {
		throw new Error(`Duplicate tool name "${def.name}"`);
	}
	// An unguarded tool is nearly always an oversight, and the cost of the
	// oversight is an agent doing something nobody authorised. Fail at boot.
	if (!def.permissions.length) {
		throw new Error(`Tool "${def.name}" declares no permissions; every tool must require at least one`);
	}
	if (def.risk !== "read" && !def.audit) {
		throw new Error(`Tool "${def.name}" is ${def.risk} and must declare an audit descriptor`);
	}
	// An irreversible action that opts out of approval is not a configuration
	// this system offers, whatever the reason seemed to be at the time.
	if (def.risk === "destructive" && def.requiresApproval === false) {
		throw new Error(`Tool "${def.name}" is destructive and cannot opt out of approval`);
	}
	// Surface an unrepresentable schema now rather than mid-conversation.
	toolInputSchema(def.input);

	registry.set(def.name, def as unknown as AnyToolDefinition);
	return def;
}

export function getTool(name: string): AnyToolDefinition | undefined {
	return registry.get(name);
}

/** Every registered tool, in registration order. */
export function listTools(): AnyToolDefinition[] {
	return [...registry.values()];
}

/**
 * The catalog as a model sees it, filtered to what this caller may actually
 * call. Showing a tool that will certainly be refused wastes context and invites
 * the model to plan around an action it cannot take.
 */
export function describeTools(options: {
	permissions: readonly string[];
	allowWrites: boolean;
	allowDestructive: boolean;
}): Array<{ name: string; title: string; description: string; risk: RiskClass; inputSchema: Record<string, unknown> }> {
	// An empty registry is a wiring mistake, never a legitimate state: tools
	// register by side-effect import, so a consumer that pulled in this module
	// without `agent/index.js` sees a catalog that is silently empty. That failure
	// looks exactly like "this user has no permissions", which is how it survives
	// review. Make it loud instead.
	if (registry.size === 0) {
		throw new Error(
			"The agent tool registry is empty. Import \"agent/index.js\" for its side effect before describing tools.",
		);
	}

	const held = new Set(options.permissions);
	return listTools()
		.filter((tool) => {
			if (tool.risk === "write" && !options.allowWrites) return false;
			if (tool.risk === "destructive" && !options.allowDestructive) return false;
			return tool.permissions.some((p) => held.has(p));
		})
		.map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			risk: tool.risk,
			inputSchema: toolInputSchema(tool.input),
		}));
}

/** Test seam. Never call from application code. */
export function __resetRegistry(): void {
	registry.clear();
}
