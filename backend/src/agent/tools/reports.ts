/**
 * `run_report` — one tool over the whole report catalog.
 *
 * `lib/reports/reportRegistry.ts` already defines 17 reports with their loaders
 * and summary logic, all of them org-scoped. Exposing them through a single
 * keyed tool gets the agent every report for the context cost of one tool
 * description, and means a report added to the registry is available to the
 * agent without touching this file.
 *
 * Row output is capped hard. Several of these return every job or line item in
 * a date range, which is a fine payload for an XLSX export and a terrible one
 * for a context window — so the summary is always returned in full and the rows
 * are a sample, clearly labelled as one.
 */

import { REPORT_MODULE, ownerModuleOn } from "../../lib/entitlements/ownership.js";
import { z } from "zod";
import { getReportDefinition, REPORT_DEFINITIONS } from "../../lib/reports/reportRegistry.js";
import { defineTool } from "../registry.js";
import { AgentErrorCodes, AgentToolError } from "../types.js";

const REPORT_KEYS = Object.keys(REPORT_DEFINITIONS) as [string, ...string[]];

/**
 * What each key actually answers, for the model's benefit. Keys are validated
 * against the registry at call time, so a report added there still works if it
 * is missing a line here — it just arrives without a hint.
 */
const REPORT_HINTS: Record<string, string> = {
	jobs: "every job in the period with status, client, and totals",
	"first-time-fix": "share of completed jobs finished in a single visit",
	invoices: "invoices raised in the period with status and balance",
	clients: "clients with lifetime job and revenue counts",
	inventory: "stock on hand and value by item",
	quotes: "quote pipeline with conversion outcomes",
	payments: "payments received in the period",
	"tax-liability": "tax collected by rate and jurisdiction",
	"reorder-forecast": "items projected to run out, with severity",
	"client-retention": "repeat versus one-off clients over time",
	"client-lifetime-value": "revenue per client since first job",
	"aged-receivables-by-client": "outstanding balances bucketed by age",
	"client-discounts": "discounts granted by client",
	"recurring-revenue": "revenue attributable to recurring plans",
	"field-added-revenue": "line items technicians added on site",
	"revenue-by-line-item-type": "revenue split across labor, material, equipment, other",
	"revenue-line-items": "individual revenue line items in the period",
};

const MAX_ROWS = 100;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

export const runReport = defineTool({
	name: "run_report",
	title: "Run report",
	description:
		"Run one of the built-in reports and get its summary figures plus a sample of rows. Reports cover revenue, " +
		"receivables, quotes, jobs, inventory, tax, and technician performance. Prefer this over listing records and " +
		"adding things up yourself — the report already applies the org's rules for what counts.\n\nAvailable keys: " +
		Object.entries(REPORT_HINTS)
			.map(([key, hint]) => `${key} (${hint})`)
			.join("; "),
	risk: "read",
	permissions: ["view_reports"],
	input: z.object({
		report: z.enum(REPORT_KEYS).describe("Which report to run."),
		start_date: isoDate.optional().describe("Start of the period, YYYY-MM-DD. Some reports ignore it."),
		end_date: isoDate.optional().describe("End of the period, YYYY-MM-DD."),
		include_inactive: z.boolean().optional().describe("Include inactive records where the report supports it."),
		lookback_days: z
			.number()
			.int()
			.min(1)
			.max(3650)
			.optional()
			.describe("Trailing window for reports that use one, such as reorder-forecast."),
		max_rows: z
			.number()
			.int()
			.min(1)
			.max(MAX_ROWS)
			.default(25)
			.describe(`Rows of detail to return alongside the summary, 1-${MAX_ROWS}.`),
	}),
	async handler({ input, ctx }) {
		const definition = getReportDefinition(input.report);
		if (!definition) {
			throw new AgentToolError(AgentErrorCodes.NOT_FOUND, `No report named "${input.report}"`);
		}
		// `view_reports` is a core permission, so the context's permission filter
		// cannot tell a quotes or inventory report from a core one.
		if (!(await ownerModuleOn(ctx.organizationId, input.report, REPORT_MODULE))) {
			throw new AgentToolError(
				AgentErrorCodes.NOT_FOUND,
				`The "${input.report}" report is not available for this organization`,
			);
		}

		const { rows, summary } = await definition.load(ctx.organizationId, {
			startDate: input.start_date,
			endDate: input.end_date,
			includeInactive: input.include_inactive,
			lookbackDays: input.lookback_days,
		});

		// Some reports compute their summary during load; others derive it from the
		// (optionally filtered) row set. Prefer whichever the definition provides.
		const resolvedSummary = summary ?? definition.filteredSummary?.(rows);

		return {
			report: input.report,
			period: { start: input.start_date, end: input.end_date },
			summary: resolvedSummary ?? null,
			total_rows: rows.length,
			returned_rows: Math.min(rows.length, input.max_rows),
			truncated: rows.length > input.max_rows,
			rows: rows.slice(0, input.max_rows),
		};
	},
});
