import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { Prisma } from "../../generated/prisma/client.js";
import {
	createSavedReportSchema,
	updateSavedReportSchema,
	createFavoriteSchema,
} from "../lib/validate/savedReports.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { log } from "../services/appLogger.js";

// Safety cap on the reports
const LIST_CAP = 500;

function getActorInfo(context?: UserContext) {
	return {
		actor_type: context?.techId
			? "technician"
			: context?.dispatcherId
				? "dispatcher"
				: "system",
		actor_id: context?.techId || context?.dispatcherId,
		ip_address: context?.ipAddress,
		user_agent: context?.userAgent,
	};
}

export const listSavedReports = async (organizationId: string, uid: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const items = await sdb.saved_report.findMany({
			where: { created_by_id: uid },
			orderBy: { updated_at: "desc" },
			take: LIST_CAP,
		});

		return { err: "", items };
	} catch (e) {
		log.error({ err: e }, "List saved reports error");
		throw e;
	}
};

export const getSavedReport = async (id: string, organizationId: string, uid: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const item = await sdb.saved_report.findFirst({ where: { id } });

		if (!item || item.created_by_id !== uid) {
			return { err: "Saved report not found" };
		}

		return { err: "", item };
	} catch (e) {
		log.error({ err: e }, "Get saved report error");
		throw e;
	}
};

export const insertSavedReport = async (
	body: unknown,
	organizationId: string,
	uid: string,
	context?: UserContext,
) => {
	try {
		const parsed = createSavedReportSchema.parse(body);

		const sdb = getScopedDb(organizationId);
		const item = await sdb.saved_report.create({
			data: {
				organization_id: organizationId,
				created_by_id: uid,
				name: parsed.name,
				source: parsed.source,
				description: parsed.description ?? null,
				config: parsed.config as Prisma.InputJsonValue,
			},
		});

		await logActivity({
			event_type: "saved_report.created",
			action: "created",
			entity_type: "saved_report",
			entity_id: item.id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: {
				name: { old: null, new: item.name },
				source: { old: null, new: item.source },
			},
		});

		return { err: "", item };
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}` };
		}
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			return { err: "A report with that name already exists" };
		}
		log.error({ err: e }, "Insert saved report error");
		throw e;
	}
};

export const updateSavedReport = async (
	id: string,
	body: unknown,
	organizationId: string,
	uid: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.saved_report.findFirst({ where: { id } });

		if (!existing || existing.created_by_id !== uid) {
			return { err: "Saved report not found" };
		}

		const parsed = updateSavedReportSchema.parse(body);

		const item = await sdb.saved_report.update({
			where: { id },
			data: {
				...(parsed.name !== undefined && { name: parsed.name }),
				...(parsed.description !== undefined && { description: parsed.description }),
				...(parsed.config !== undefined && {
					config: parsed.config as Prisma.InputJsonValue,
				}),
			},
		});

		await logActivity({
			event_type: "saved_report.updated",
			action: "updated",
			entity_type: "saved_report",
			entity_id: item.id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: buildChanges(existing, parsed, ["name", "description", "config"]),
		});

		return { err: "", item };
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}` };
		}
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			return { err: "A report with that name already exists" };
		}
		log.error({ err: e }, "Update saved report error");
		throw e;
	}
};

export const deleteSavedReport = async (
	id: string,
	organizationId: string,
	uid: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.saved_report.findFirst({ where: { id } });

		if (!existing || existing.created_by_id !== uid) {
			return { err: "Saved report not found" };
		}

		await sdb.saved_report.delete({ where: { id } });

		await logActivity({
			event_type: "saved_report.deleted",
			action: "deleted",
			entity_type: "saved_report",
			entity_id: id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: { name: { old: existing.name, new: null } },
		});

		return { err: "", item: { id } };
	} catch (e) {
		log.error({ err: e }, "Delete saved report error");
		throw e;
	}
};

export const listFavorites = async (organizationId: string, uid: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const items = await sdb.report_favorite.findMany({
			where: { dispatcher_id: uid },
			orderBy: { created_at: "desc" },
			take: LIST_CAP,
		});

		return { err: "", items };
	} catch (e) {
		log.error({ err: e }, "List report favorites error");
		throw e;
	}
};

export const addFavorite = async (
	body: unknown,
	organizationId: string,
	uid: string,
	context?: UserContext,
) => {
	let parsed;
	try {
		parsed = createFavoriteSchema.parse(body);
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}` };
		}
		throw e;
	}

	const sdb = getScopedDb(organizationId);
	const where = { dispatcher_id: uid, kind: parsed.kind, ref: parsed.ref };

	try {
		const existing = await sdb.report_favorite.findFirst({ where });
		if (existing) {
			return { err: "", item: existing };
		}

		const item = await sdb.report_favorite.create({
			data: { organization_id: organizationId, ...where },
		});

		await logActivity({
			event_type: "report_favorite.created",
			action: "created",
			entity_type: "report_favorite",
			entity_id: item.id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: {
				kind: { old: null, new: item.kind },
				ref: { old: null, new: item.ref },
			},
		});

		return { err: "", item };
	} catch (e) {
		// Race between the find-then-create above: the unique constraint
		// (dispatcher_id, kind, ref) caught it — treat as idempotent success.
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			const existing = await sdb.report_favorite.findFirst({ where });
			if (existing) {
				return { err: "", item: existing };
			}
		}
		log.error({ err: e }, "Add report favorite error");
		throw e;
	}
};

export const removeFavorite = async (
	id: string,
	organizationId: string,
	uid: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.report_favorite.findFirst({ where: { id } });

		if (!existing || existing.dispatcher_id !== uid) {
			return { err: "Favorite not found" };
		}

		await sdb.report_favorite.delete({ where: { id } });

		await logActivity({
			event_type: "report_favorite.deleted",
			action: "deleted",
			entity_type: "report_favorite",
			entity_id: id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: {
				kind: { old: existing.kind, new: null },
				ref: { old: existing.ref, new: null },
			},
		});

		return { err: "", item: { id } };
	} catch (e) {
		log.error({ err: e }, "Remove report favorite error");
		throw e;
	}
};
