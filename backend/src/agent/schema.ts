/**
 * Zod → JSON Schema for tool input.
 *
 * The point of this module is that tool schemas are never hand-written. Every
 * write tool reuses the same validator the REST route uses (`lib/validate/*`),
 * so an agent cannot be handed a contract that has drifted from the one the
 * controller enforces.
 *
 * Two details that are load-bearing:
 *
 * 1. `io: "input"` is mandatory, not a preference. Most validators in this repo
 *    end in `.transform()`; asked for the *output* shape, Zod correctly reports
 *    that a transform's result is unrepresentable and returns a bare `{}`. The
 *    input side is also the side we want — it describes what a caller sends.
 *
 * 2. Schemas are shipped to the model on every request, so their size is a
 *    running token cost. `z.uuid()` alone expands to a ~140-character regex,
 *    which buys nothing: the model cannot usefully satisfy a regex it is shown,
 *    and Zod re-validates server-side regardless. `format` is kept, `pattern`
 *    is dropped.
 */

import { z } from "zod";

/** JSON Schema object, loose enough to walk without fighting the type system. */
type JsonSchemaNode = Record<string, unknown>;

/**
 * Formats whose `pattern` is redundant with the `format` keyword. Dropping the
 * regex keeps the advertised contract identical while cutting schema size
 * substantially across a catalog this size.
 */
const REDUNDANT_PATTERN_FORMATS = new Set(["uuid", "email", "uri", "url", "date-time", "date", "time"]);

/**
 * Keywords whose value is a MAP of schemas keyed by arbitrary names. Inside
 * these, a key is a property name and must never be treated as a JSON Schema
 * keyword — a tool taking an `id` parameter would otherwise lose it.
 */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);

/** Keywords whose value is a schema, or a list of schemas. */
const SCHEMA_VALUE_KEYWORDS = new Set([
	"items",
	"prefixItems",
	"additionalProperties",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"anyOf",
	"allOf",
	"oneOf",
]);

/** Meta keywords the MCP / Anthropic tool contract does not read. */
const DROPPED_META = new Set(["$schema", "$id"]);

/** Walk a node that is itself a schema, applying keyword rules. */
function pruneSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(pruneSchema);
	if (!node || typeof node !== "object") return node;

	const source = node as JsonSchemaNode;
	const dropPattern = REDUNDANT_PATTERN_FORMATS.has(String(source.format));
	const out: JsonSchemaNode = {};

	for (const [key, value] of Object.entries(source)) {
		if (DROPPED_META.has(key)) continue;
		if (key === "pattern" && dropPattern) continue;

		if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = pruneSchemaMap(value);
		else if (SCHEMA_VALUE_KEYWORDS.has(key)) out[key] = pruneSchema(value);
		// Everything else is a plain value (type, enum, default, description...)
		// and is copied through untouched.
		else out[key] = value;
	}
	return out;
}

/** Walk a map whose KEYS are names and whose VALUES are schemas. */
function pruneSchemaMap(node: unknown): unknown {
	if (!node || typeof node !== "object" || Array.isArray(node)) return node;
	const out: JsonSchemaNode = {};
	for (const [name, schema] of Object.entries(node as JsonSchemaNode)) {
		out[name] = pruneSchema(schema);
	}
	return out;
}

/**
 * Convert a Zod schema into the JSON Schema a tool advertises.
 *
 * Throws on registration (not at call time) if a schema cannot be represented,
 * so a bad tool fails at boot rather than mid-conversation.
 */
export function toolInputSchema(schema: z.ZodType): JsonSchemaNode {
	const raw = z.toJSONSchema(schema, {
		io: "input",
		target: "draft-2020-12",
		// A field Zod cannot express (a bare `.refine` on an unknown, say) becomes
		// permissive rather than aborting the whole schema. Server-side validation
		// still rejects bad values — this only affects what the model is shown.
		unrepresentable: "any",
	}) as JsonSchemaNode;

	const pruned = pruneSchema(raw) as JsonSchemaNode;

	// Providers expect an object at the top level. A schema that is not one — a
	// discriminated union renders as a bare `oneOf`, for instance — cannot be
	// advertised faithfully, and MUST NOT be quietly replaced with an empty
	// object: that tells the model the tool takes no arguments, it calls with
	// `{}`, validation rejects it, and the model invents a plausible explanation
	// for a failure it cannot see the cause of. That exact bug shipped in
	// `propose_draft`. Fail at registration instead, where it is obvious.
	if (pruned.type !== "object") {
		const shape = Object.keys(pruned).filter((k) => k !== "$schema").join(", ") || "nothing";
		throw new Error(
			`Tool input must be an object schema at the top level, got: ${shape}. ` +
				"Wrap it in z.object({...}); a discriminated union cannot be advertised as-is.",
		);
	}
	if (!pruned.properties) pruned.properties = {};
	return pruned;
}
