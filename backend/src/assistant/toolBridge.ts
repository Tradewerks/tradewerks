/**
 * Adapter between the agent registry and OpenAI's function-calling format.
 *
 * This is the whole reason Phase 1 built a transport-agnostic registry: the
 * assistant does not define tools, it renders the ones that already exist. The
 * MCP server renders the same list a different way, and neither can drift from
 * the other.
 */

import type OpenAI from "openai";
import { describeTools } from "../agent/registry.js";
import type { AgentContext, AgentPolicy } from "../agent/types.js";

/**
 * The catalog in the Responses API's shape, filtered to what this caller may
 * actually call.
 *
 * Flat — `name` and `parameters` on the tool itself — where Chat Completions
 * nested them under `function`. That is the only difference; the schemas come
 * from the same registry either way.
 *
 * `strict` is deliberately false rather than omitted. Strict mode requires every
 * property to be listed in `required` and `additionalProperties: false`
 * throughout, which the Zod-derived schemas do not satisfy — most tool
 * parameters are genuinely optional. Loosening the schemas to satisfy strict
 * mode would mean advertising a contract the server does not enforce, which is
 * the wrong trade: the server re-validates every call with Zod regardless, so a
 * malformed call fails with a structured error the model can correct rather
 * than silently succeeding.
 */
export function toolsForOpenAI(ctx: AgentContext, policy: AgentPolicy): OpenAI.Responses.FunctionTool[] {
	return describeTools({
		permissions: ctx.permissions,
		allowWrites: policy.allowWrites,
		allowDestructive: policy.allowDestructive,
	}).map((tool) => ({
		type: "function" as const,
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema as Record<string, unknown>,
		strict: false,
	}));
}

/**
 * Parse the arguments string a model streamed.
 *
 * Models occasionally emit malformed JSON, especially when a turn is truncated.
 * Returning a marker rather than throwing lets the caller feed the parse failure
 * back as a tool result, which the model can retry — throwing would end the turn
 * over a recoverable mistake.
 */
export function parseToolArguments(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: true, value: {} };
	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch (err) {
		return { ok: false, message: `Arguments were not valid JSON: ${(err as Error).message}` };
	}
}

/**
 * Shared by both one-liners below, so a time reads the same before and after a call.
 *
 * Accepts a Date as well as a string: the arguments a model sent have been
 * through JSON and arrive as strings, but a tool handler returns whatever Prisma
 * gave it, which is a Date. Taking only strings would silently drop the time
 * from every write summary while the approval prompt above still showed one.
 */
function when(value: unknown): string | null {
	if (!(typeof value === "string" || value instanceof Date)) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace("T", " ").slice(0, 16);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A one-line account of what a call is ABOUT to do, for the approval prompt.
 *
 * This is the sentence a dispatcher decides on, so it has to say what will
 * change in their words, not restate the arguments. Anything it cannot describe
 * precisely falls back to the tool's own title — vague is acceptable here,
 * wrong is not: the card also shows the exact arguments underneath.
 */
export function describeToolCall(toolName: string, input: unknown): string {
	const args = (input ?? {}) as Record<string, unknown>;

	switch (toolName) {
		case "schedule_visit": {
			const start = when(args.scheduled_start_at);
			const techs = Array.isArray(args.tech_ids) ? args.tech_ids.length : 0;
			const who = techs === 0 ? "no technician assigned" : plural(techs, "technician");
			return `Schedule “${String(args.name ?? "a visit")}”${start ? ` for ${start}` : ""} — ${who}`;
		}
		case "reschedule_visit": {
			const start = when(args.scheduled_start_at);
			return start ? `Move this visit to ${start}` : "Change this visit's timing";
		}
		case "assign_technician": {
			const techs = Array.isArray(args.tech_ids) ? args.tech_ids.length : 0;
			return techs === 0
				? "Remove every technician from this visit"
				: `Set this visit's technicians — ${plural(techs, "technician")} assigned, replacing whoever is on it now`;
		}
		case "update_job_status": {
			const status = String(args.status ?? "");
			return status === "Cancelled"
				? `Cancel this job — ${String(args.cancellation_reason ?? "no reason given")}`
				: `Set this job's status to ${status}`;
		}
		default:
			return `Run ${toolName.replace(/_/g, " ")}`;
	}
}

/**
 * A one-line, human-readable account of what a call did, for the tool card in
 * the UI. The model gets the full result; a dispatcher gets a sentence.
 */
export function summariseToolResult(toolName: string, input: unknown, data: unknown): string {
	const record = (data ?? {}) as Record<string, unknown>;
	const args = (input ?? {}) as Record<string, unknown>;

	// The writes are matched on name rather than on the shape of what they
	// returned. A write returns ids and a status — a shape too thin to recognise,
	// and the one a dispatcher most needs stated back to them, because it is the
	// only card in the thread that reports something that actually changed.
	switch (toolName) {
		case "schedule_visit": {
			const start = when(record.scheduled_start_at);
			const techs = typeof record.assigned === "number" ? record.assigned : 0;
			const who = techs === 0 ? "nobody assigned yet" : plural(techs, "technician");
			return `Scheduled “${String(args.name ?? "a visit")}”${start ? ` for ${start}` : ""} — ${who}`;
		}
		case "reschedule_visit": {
			const start = when(record.scheduled_start_at);
			return start ? `Moved the visit to ${start}` : "Changed the visit's timing";
		}
		case "assign_technician": {
			const techs = typeof record.assigned === "number" ? record.assigned : 0;
			return techs === 0
				? "Cleared every technician from the visit"
				: `Assigned ${plural(techs, "technician")} to the visit`;
		}
		case "update_job_status": {
			const job = record.job_number ? ` ${String(record.job_number)}` : "";
			return `Set job${job} to ${String(record.status ?? args.status ?? "a new status")}`;
		}
		case "add_job_note": {
			// The note's own words identify it far better than its id does.
			const content = typeof args.content === "string" ? args.content.trim() : "";
			const excerpt = content.length > 60 ? `${content.slice(0, 60).trimEnd()}…` : content;
			return excerpt ? `Added a note — “${excerpt}”` : "Added a note to the job";
		}
	}

	if (Array.isArray(record.hits)) {
		return `Searched for “${String(args.query ?? "")}” — ${record.hits.length} match${record.hits.length === 1 ? "" : "es"}`;
	}
	if (typeof record.returned === "number" && typeof record.total === "number") {
		return `Listed ${record.returned} of ${record.total} ${String(args.type ?? "record")}${record.total === 1 ? "" : "s"}`;
	}
	if (typeof record.total_visits === "number") {
		const unassigned = Array.isArray(record.unassigned) ? record.unassigned.length : 0;
		return `Read the schedule — ${record.total_visits} visit${record.total_visits === 1 ? "" : "s"}, ${unassigned} unassigned`;
	}
	if (Array.isArray(record.technicians)) {
		return `Checked availability for ${record.technicians.length} technician${record.technicians.length === 1 ? "" : "s"}`;
	}
	if (Array.isArray(record.items)) {
		return `Checked stock — ${record.items.length} item${record.items.length === 1 ? "" : "s"}`;
	}
	if (typeof record.report === "string") {
		return `Ran the ${record.report} report`;
	}
	if (Array.isArray(record.entries)) {
		return `Read ${record.entries.length} history entr${record.entries.length === 1 ? "y" : "ies"}`;
	}
	if (record.status === "saved_as_draft") {
		return `Drafted a ${String(record.form_type ?? "record")} — “${String(record.label ?? "untitled")}” (needs review before it exists)`;
	}
	if (record.found === false) {
		return `Looked up a ${String(args.type ?? "record")} — not found`;
	}
	if (typeof record.type === "string") {
		const label = record.job_number ?? record.quote_number ?? record.invoice_number ?? record.name ?? record.title;
		return label ? `Opened ${record.type} ${String(label)}` : `Opened a ${record.type}`;
	}
	return `Ran ${toolName}`;
}
