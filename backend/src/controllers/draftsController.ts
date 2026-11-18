import { ZodError } from "zod";
import { getScopedDb } from "../lib/context.js";
import { Prisma } from "../../generated/prisma/client.js";
import {
	createDraftSchema,
	updateDraftSchema,
	listDraftsQuerySchema,
} from "../lib/validate/drafts.js";
import { deriveDraftLabel } from "../services/draftLabel.js";
import { Request } from "express";
import { log } from "../services/appLogger.js";

//Returns the list view — id, label, form_type, entity_context_id, timestamps.
export const getAllDrafts = async (req: Request) => {
	try {
		const organizationId = req.user?.organization_id;
		if (!organizationId) {
			return { err: "Organization not found" };
		}

		const query = listDraftsQuerySchema.parse({
			form_type: req.query["form_type"],
			entity_context_id: req.query["entity_context_id"],
		});

		const sdb = getScopedDb(organizationId);
		const drafts = await sdb.form_draft.findMany({
			where: {
				...(query.form_type && { form_type: query.form_type }),
				...(query.entity_context_id && {
					entity_context_id: query.entity_context_id,
				}),
			},
			select: {
				id: true,
				form_type: true,
				label: true,
				entity_context_id: true,
				created_at: true,
				updated_at: true,
				// payload included only to extract client_id for filtering
				payload: true,
			},
			orderBy: { updated_at: "desc" },
		});

		// Extract client_id and total from payload for list view
		const items = drafts.map(({ payload, ...rest }) => {
			const p = payload as Record<string, unknown>;
			return {
				...rest,
				client_id: (p?.["client_id"] as string | null) ?? null,
				total:
					typeof p?.["total"] === "number"
						? (p["total"] as number)
						: null,
			};
		});

		return { err: "", items };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Invalid query parameters: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Get all drafts error");
		throw e;
	}
};

export const getDraftById = async (id: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const draft = await sdb.form_draft.findFirst({
			where: { id },
		});

		if (!draft) {
			return { err: "Draft not found" };
		}

		return { err: "", item: draft };
	} catch (e) {
		log.error({ err: e }, "Get draft by id error");
		throw e;
	}
};

export const insertDraft = async (req: Request) => {
	try {
		const organizationId = req.user?.organization_id;
		if (!organizationId) {
			return { err: "Organization not found" };
		}

		const parsed = createDraftSchema.parse(req.body);

		const label = deriveDraftLabel(parsed.form_type, parsed.payload);
		const sdb = getScopedDb(organizationId);
		const draft = await sdb.form_draft.create({
			data: {
				organization_id: organizationId,
				form_type: parsed.form_type,
				label,
				payload: parsed.payload as Prisma.InputJsonValue,
				entity_context_id: parsed.entity_context_id ?? null,
			},
		});

		return { err: "", item: draft };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Insert draft error");
		throw e;
	}
};

export const updateDraft = async (id: string, req: Request) => {
	try {
		const organizationId = req.user?.organization_id;
		if (!organizationId) {
			return { err: "Organization not found" };
		}

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.form_draft.findFirst({
			where: { id },
			select: { id: true, form_type: true },
		});

		if (!existing) {
			return { err: "Draft not found" };
		}

		const parsed = updateDraftSchema.parse(req.body);
		const label = deriveDraftLabel(existing.form_type, parsed.payload);

		const updated = await sdb.form_draft.update({
			where: { id },
			data: {
				payload: parsed.payload as Prisma.InputJsonValue,
				label,
			},
		});

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Update draft error");
		throw e;
	}
};

export const deleteDraft = async (id: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.form_draft.findFirst({
			where: { id },
		});

		if (!existing) {
			return { err: "Draft not found" };
		}

		await sdb.form_draft.delete({ where: { id } });

		return { err: "", item: { id } };
	} catch (e) {
		log.error({ err: e }, "Delete draft error");
		throw e;
	}
};
