/**
 * `propose_draft` — how the assistant creates records.
 *
 * It does not create them. It fills in the same draft the Create panel already
 * saves, and a dispatcher opens it, checks it, and submits. That reuses a review
 * path the product already has rather than inventing a second one, and it means
 * the assistant can be genuinely useful at the tedious part (assembling a quote
 * from a conversation) without ever being the thing that commits it.
 *
 * Because a human reviews the draft before anything real happens, this tool sets
 * `requiresApproval: false`: gating it would ask for the same approval twice.
 */

import { z } from "zod";
import { insertDraft } from "../../controllers/draftsController.js";
import { FORM_DRAFT_TYPES } from "../../lib/validate/drafts.js";
import { requestFor, unwrap, type ControllerOutcome } from "../controllerBridge.js";
import { defineTool } from "../registry.js";
import { AgentErrorCodes, AgentToolError } from "../types.js";

/**
 * Payload shapes, mirroring what each Create form saves and reloads.
 *
 * These are looser than the corresponding create-schemas on purpose: a draft is
 * explicitly incomplete work. A quote draft with no line items yet is a normal
 * thing for a dispatcher to be handed; the strict schema runs on submit, in the
 * form, where a person can see what is missing.
 */
const lineItem = z.object({
	name: z.string().min(1).describe("What the line is for."),
	description: z.string().nullish(),
	quantity: z.number().positive(),
	unit_price: z.number().min(0),
	total: z.number().min(0).optional().describe("Omit to let the form compute quantity × unit_price."),
	item_type: z.enum(["labor", "material", "equipment", "other"]).nullish(),
});

const coords = z.object({ lat: z.number(), lon: z.number() });

const requestPayload = z.object({
	title: z.string().min(1),
	description: z.string().default(""),
	client_id: z.string().uuid(),
	priority: z.enum(["Low", "Medium", "High", "Urgent", "Emergency"]).default("Medium"),
	address: z.string().optional(),
	coords: coords.optional(),
	source: z.string().nullish().describe('Where it came from, e.g. "phone", "email".'),
	source_reference: z.string().nullish(),
	requires_quote: z.boolean().default(false),
	estimated_value: z.number().min(0).nullish(),
});

const quotePayload = z.object({
	title: z.string().min(1),
	description: z.string().default(""),
	client_id: z.string().uuid(),
	priority: z.enum(["Low", "Medium", "High", "Urgent", "Emergency"]).default("Medium"),
	address: z.string().optional(),
	coords: coords.optional(),
	line_items: z.array(lineItem).default([]),
	valid_until: z.string().optional().describe("ISO 8601 datetime."),
	expires_at: z.string().optional().describe("ISO 8601 datetime."),
});

const jobPayload = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	client_id: z.string().uuid(),
	priority: z.enum(["Low", "Medium", "High", "Urgent", "Emergency"]).default("Medium"),
	address: z.string().optional(),
	coords: coords.optional(),
	line_items: z.array(lineItem).default([]),
});

const visitPayload = z.object({
	name: z.string().min(1),
	description: z.string().nullish(),
	job_id: z.string().uuid(),
	tech_ids: z.array(z.string().uuid()).default([]),
	line_items: z.array(lineItem).default([]),
});

const recurringPlanPayload = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	client_id: z.string().uuid(),
	address: z.string().optional(),
	coords: coords.optional(),
	line_items: z.array(lineItem).default([]),
});

/** The authoritative schema per draft type, applied by the refinement below. */
const PAYLOAD_FOR = {
	request: requestPayload,
	quote: quotePayload,
	job: jobPayload,
	job_visit: visitPayload,
	recurring_plan: recurringPlanPayload,
} as const;

/** Permission needed to propose each kind, matching the create permission for the real thing. */
const PERMISSION_FOR = {
	request: "create_requests",
	quote: "create_quotes",
	job: "create_jobs",
	job_visit: "create_jobs",
	recurring_plan: "manage_recurring_plans",
	invoice: "create_invoices",
} as const satisfies Record<(typeof FORM_DRAFT_TYPES)[number], string>;

export const proposeDraft = defineTool({
	name: "propose_draft",
	title: "Propose a draft",
	description:
		"Prepare a draft request, quote, job, visit or recurring plan for a person to review and submit. This is how " +
		"you create things: it does NOT create the record — it fills in the same draft form a dispatcher would, and " +
		"they open it, check it, and submit. Use it when asked to write up a quote, log a call as a request, or set " +
		"up a job. Resolve the client with search_records first so client_id is right. Say clearly afterwards that " +
		"you saved a draft for them to review, and where to find it.",
	risk: "write",
	// The draft IS the review step. Gating it would ask for the same approval twice.
	requiresApproval: false,
	permissions: [...new Set(Object.values(PERMISSION_FOR))],
	/**
	 * A flat object, NOT a discriminated union.
	 *
	 * `z.discriminatedUnion` renders as a bare top-level `oneOf` with no `type`,
	 * which providers cannot advertise as function parameters — the model ends up
	 * being told this tool takes no arguments at all. `payload` carries the union
	 * instead, so the top level stays an object and every field stays visible.
	 * The `form_type` ↔ `payload` pairing is enforced in the refinement below,
	 * which is also what produces a useful error when they disagree.
	 */
	input: z
		.object({
			form_type: z
				.enum(["request", "quote", "job", "job_visit", "recurring_plan"])
				.describe("What kind of record to draft. The payload must match this."),
			payload: z
				.union([requestPayload, quotePayload, jobPayload, visitPayload, recurringPlanPayload])
				.describe("The draft's contents. Which fields apply depends on form_type."),
		})
		.superRefine((value, ctx) => {
			// The union above accepts any of the five shapes; this is what pins the
			// payload to the type actually requested, and reports precisely what is
			// wrong rather than "no matching variant".
			const parsed = PAYLOAD_FOR[value.form_type].safeParse(value.payload);
			if (parsed.success) return;
			for (const issue of parsed.error.issues) {
				ctx.addIssue({
					code: "custom",
					path: ["payload", ...issue.path],
					message: `${issue.message} (required for a ${value.form_type} draft)`,
				});
			}
		}),
	audit: (input, result) => ({
		event_type: "form_draft.created",
		action: "created",
		entity_type: "form_draft",
		entity_id: (result as { id?: string })?.id ?? "unknown",
		reason: `Assistant drafted a ${input.form_type} for review`,
	}),
	invalidates: () => ["drafts"],
	async handler({ input, ctx }) {
		const needed = PERMISSION_FOR[input.form_type];
		if (!ctx.permissions.includes(needed)) {
			// The registry gate is ANY-OF across every draft type; re-check the one
			// actually asked for, or create_requests alone would unlock quotes.
			throw new AgentToolError(
				AgentErrorCodes.FORBIDDEN,
				`Not permitted to draft a ${input.form_type}; needs ${needed}`,
			);
		}

		// Re-parse with the type's own schema so defaults are applied and the
		// controller stores the coerced payload, not the raw union match.
		const payload = PAYLOAD_FOR[input.form_type].parse(input.payload);

		const outcome = (await insertDraft(
			requestFor(ctx, {
				form_type: input.form_type,
				payload,
				// A visit draft belongs to a job; the Create panel uses this to offer
				// the draft on that job's page.
				entity_context_id: "job_id" in payload ? payload.job_id : null,
			}),
		)) as ControllerOutcome<{ id: string; label: string; form_type: string }>;

		const draft = unwrap(outcome, "Creating the draft");

		return {
			id: draft.id,
			form_type: draft.form_type,
			label: draft.label,
			status: "saved_as_draft",
			// Tell the model plainly, so it does not report the record as created.
			note: "Saved as a draft. Nothing has been created yet — a dispatcher must open this draft and submit it.",
		};
	},
});
