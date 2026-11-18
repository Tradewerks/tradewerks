import { getScopedDb } from "../lib/context.js";
import { Prisma, followup_enrollment_status } from "../../generated/prisma/client.js";
import {
	CreateSequenceInput,
	UpdateSequenceInput,
	EnrollInput,
} from "../lib/validate/followups.js";
import { resolveStepSendAt, resolveContact } from "../services/followupEngine.js";

// Errors below carry a `status` so route handlers can map them to the right
// HTTP response (see routes/followups.ts), mirroring the pattern already used
// by services/emailService.ts (e.g. sendQuoteEmail's "Quote not found").
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });
const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

const stepOrderAsc = { orderBy: { step_order: "asc" as const } };

// ============================================================================
// Sequences
// ============================================================================

export async function listSequences(orgId: string) {
	const sdb = getScopedDb(orgId);
	return sdb.followup_sequence.findMany({
		include: {
			steps: stepOrderAsc,
			_count: { select: { enrollments: true } },
		},
		orderBy: { created_at: "desc" },
	});
}

export async function getSequence(id: string, orgId: string) {
	const sdb = getScopedDb(orgId);
	const seq = await sdb.followup_sequence.findFirst({
		where: { id },
		include: { steps: stepOrderAsc },
	});
	if (!seq) throw notFound("Sequence not found");
	return seq;
}

export async function createSequence(
	input: CreateSequenceInput,
	orgId: string,
	dispatcherId: string,
) {
	const sdb = getScopedDb(orgId);
	return sdb.$transaction(async (tx) => {
		const seq = await tx.followup_sequence.create({
			data: {
				organization_id: orgId,
				name: input.name,
				description: input.description ?? null,
				trigger_type: input.trigger_type,
				trigger_config:
					input.trigger_config == null
						? Prisma.JsonNull
						: (input.trigger_config as Prisma.InputJsonValue),
				stop_on_open: input.stop_on_open,
				is_active: input.is_active,
				created_by_dispatcher_id: dispatcherId,
			},
		});

		await tx.followup_step.createMany({
			data: input.steps.map((step) => ({
				sequence_id: seq.id,
				step_order: step.step_order,
				category: step.category,
				delay_amount: step.delay_amount,
				delay_unit: step.delay_unit,
				condition: step.condition,
			})),
		});

		const steps = await tx.followup_step.findMany({
			where: { sequence_id: seq.id },
			orderBy: { step_order: "asc" },
		});

		return { ...seq, steps };
	});
}

export async function updateSequence(id: string, input: UpdateSequenceInput, orgId: string) {
	const sdb = getScopedDb(orgId);
	const existing = await sdb.followup_sequence.findFirst({ where: { id } });
	if (!existing) throw notFound("Sequence not found");

	return sdb.$transaction(async (tx) => {
		const seq = await tx.followup_sequence.update({
			where: { id },
			data: {
				...(input.name !== undefined && { name: input.name }),
				...(input.description !== undefined && { description: input.description }),
				...(input.trigger_type !== undefined && { trigger_type: input.trigger_type }),
				...(input.trigger_config !== undefined && {
					trigger_config:
						input.trigger_config == null
							? Prisma.JsonNull
							: (input.trigger_config as Prisma.InputJsonValue),
				}),
				...(input.stop_on_open !== undefined && { stop_on_open: input.stop_on_open }),
				...(input.is_active !== undefined && { is_active: input.is_active }),
			},
		});

		if (input.steps !== undefined) {
			await tx.followup_step.deleteMany({ where: { sequence_id: id } });
			await tx.followup_step.createMany({
				data: input.steps.map((step) => ({
					sequence_id: id,
					step_order: step.step_order,
					category: step.category,
					delay_amount: step.delay_amount,
					delay_unit: step.delay_unit,
					condition: step.condition,
				})),
			});
		}

		const steps = await tx.followup_step.findMany({
			where: { sequence_id: id },
			orderBy: { step_order: "asc" },
		});

		return { ...seq, steps };
	});
}

export async function deleteSequence(id: string, orgId: string) {
	const sdb = getScopedDb(orgId);
	const existing = await sdb.followup_sequence.findFirst({
		where: { id },
		select: { _count: { select: { enrollments: true } } },
	});
	if (!existing) throw notFound("Sequence not found");
	// Enrollments cascade with their send records, the only record of what was emailed.
	if (existing._count.enrollments > 0)
		throw conflict(
			"This sequence has enrollments, so it can't be deleted. Deactivate it instead.",
		);

	await sdb.followup_sequence.delete({ where: { id } });
	return { id };
}

// ============================================================================
// Enrollments
// ============================================================================

export async function listEnrollments(
	orgId: string,
	filters?: { status?: string; client_id?: string },
) {
	const sdb = getScopedDb(orgId);
	const validStatuses: string[] = Object.values(followup_enrollment_status);
	const status =
		filters?.status && validStatuses.includes(filters.status)
			? (filters.status as followup_enrollment_status)
			: undefined;

	return sdb.followup_enrollment.findMany({
		where: {
			...(status && { status }),
			...(filters?.client_id && { client_id: filters.client_id }),
		},
		include: {
			sequence: { select: { name: true, trigger_type: true } },
			client: { select: { name: true } },
			sends: { orderBy: { sent_at: "desc" } },
		},
		orderBy: { created_at: "desc" },
		take: 200,
	});
}

export async function enroll(input: EnrollInput, orgId: string, dispatcherId: string) {
	const sdb = getScopedDb(orgId);

	const seq = await sdb.followup_sequence.findFirst({
		where: { id: input.sequence_id },
		include: { steps: stepOrderAsc },
	});
	if (!seq) throw notFound("Sequence not found");
	if (!seq.is_active) throw badRequest("Sequence is not active");
	if (seq.steps.length === 0) throw badRequest("Sequence has no steps");
	// Reminder (before-anchor) sequences need a target date, else the first step
	// would be scheduled for "now" and fire immediately instead of before the visit.
	if (seq.trigger_type === "visit_scheduled" && !input.scheduled_at) {
		throw badRequest("scheduled_at (the visit time) is required for a reminder sequence");
	}

	// Always load the client (scoped) — this both confirms the client belongs
	// to this org and gives us its contacts to fall back to for a recipient.
	const client = await sdb.client.findFirst({
		where: { id: input.client_id },
		include: { contacts: { include: { contact: true } } },
	});
	if (!client) throw notFound("Client not found");

	// The stored contact_id is what lets each send carry an unsubscribe link, so
	// an overridden address is tied back to the client's contact holding it.
	const eligible = client.contacts.filter(
		(c) => !!c.contact?.email && c.contact.is_active !== false && c.contact.type !== "vendor",
	);
	const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
	let contactId: string | null = null;
	let recipientEmail: string | null = null;
	if (input.contact_id) {
		const picked = eligible.find((c) => c.contact_id === input.contact_id);
		if (!picked) throw badRequest("Contact is not an active contact of this client");
		if (input.recipient_email && !sameEmail(input.recipient_email, picked.contact!.email!)) {
			throw badRequest("recipient_email does not match the selected contact");
		}
		contactId = picked.contact_id;
		recipientEmail = input.recipient_email ?? picked.contact!.email!;
	} else if (input.recipient_email) {
		recipientEmail = input.recipient_email;
		contactId =
			eligible.find((c) => sameEmail(c.contact!.email!, input.recipient_email!))?.contact_id ?? null;
	} else {
		const resolved = resolveContact(client.contacts);
		contactId = resolved?.contact_id ?? null;
		recipientEmail = resolved?.email ?? null;
	}
	if (!recipientEmail) throw badRequest("No recipient email available for this client");

	const firstStep = seq.steps[0];
	const now = new Date();
	let anchorAt: Date | null = null;
	let base = now;
	if (seq.trigger_type === "date_based") {
		anchorAt = input.scheduled_at ?? now;
		base = input.scheduled_at ?? now;
	}
	if (seq.trigger_type === "visit_scheduled") {
		anchorAt = input.scheduled_at ?? null;
	}
	const next_send_at = resolveStepSendAt(seq, firstStep, { base, anchorAt });

	try {
		return await sdb.followup_enrollment.create({
			data: {
				organization_id: orgId,
				sequence_id: input.sequence_id,
				client_id: input.client_id,
				contact_id: contactId,
				recipient_email: recipientEmail,
				status: "active",
				current_step_order: 0,
				next_send_at,
				anchor_at: anchorAt,
				anchor_entity_type: null,
				anchor_entity_id: null,
				enrolled_by_dispatcher_id: dispatcherId,
			},
		});
	} catch (e) {
		// Defensive: manual enrollments carry anchor_entity_id = null so today's
		// schema (no unique constraint on that combination) can't collide here,
		// but a future partial-unique-index on the active anchor should map
		// cleanly to a 409 rather than a raw 500.
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			throw conflict("An active enrollment already exists");
		}
		throw e;
	}
}

export async function stopEnrollment(id: string, orgId: string) {
	const sdb = getScopedDb(orgId);
	const existing = await sdb.followup_enrollment.findFirst({ where: { id } });
	if (!existing) throw notFound("Enrollment not found");

	return sdb.followup_enrollment.update({
		where: { id },
		data: {
			status: "stopped",
			stopped_at: new Date(),
			stop_reason: "manual",
			next_send_at: null,
		},
	});
}
