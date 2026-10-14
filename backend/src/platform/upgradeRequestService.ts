import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { getModule } from "../lib/entitlements/registry.js";
import {
	STAFF_ACTOR_NAME,
	getEntitlements,
} from "../services/entitlementService.js";
import { emitToOrg } from "../services/socketService.js";
import { notifyRequestResolved } from "./requestNotice.js";
import { closeRequestTx, requestClosed } from "./requestClose.js";
import { badRequest, isUniqueViolation } from "./errors.js";
import type { StaffActor } from "./staffService.js";

export type RequestStatus = "open" | "approved" | "declined" | "withdrawn";
type Row = {
	id: string;
	organization_id: string;
	requested_by_id: string;
	requested_by_name: string;
	requested_plan_key: string | null;
	requested_modules: string[];
	note: string | null;
	status: string;
	resolution_note: string | null;
	resolved_at: Date | null;
	created_at: Date;
};
export type RequestView = Omit<
	Row,
	"requested_modules" | "status" | "resolved_at" | "created_at"
> & {
	requested_plan_label: string | null;
	requested_modules: { key: string; label: string }[];
	status: RequestStatus;
	resolved_at: string | null;
	created_at: string;
};

const moduleRef = (key: string) => ({
	key,
	label: getModule(key)?.label ?? key,
});

async function toViews(rows: Row[]): Promise<RequestView[]> {
	const keys = [
		...new Set(
			rows
				.map((r) => r.requested_plan_key)
				.filter((k): k is string => !!k),
		),
	];
	const plans = keys.length
		? await db.plan.findMany({
				where: { key: { in: keys } },
				select: { key: true, label: true },
			})
		: [];
	const labels = new Map(plans.map((p) => [p.key, p.label]));
	// Field by field: a spread would also pass resolved_by_id (a staff id) to customers.
	return rows.map((r) => ({
		id: r.id,
		organization_id: r.organization_id,
		requested_by_id: r.requested_by_id,
		requested_by_name: r.requested_by_name,
		requested_plan_key: r.requested_plan_key,
		note: r.note,
		resolution_note: r.resolution_note,
		status: r.status as RequestStatus,
		requested_plan_label: r.requested_plan_key
			? (labels.get(r.requested_plan_key) ?? r.requested_plan_key)
			: null,
		requested_modules: r.requested_modules.map(moduleRef),
		resolved_at: r.resolved_at?.toISOString() ?? null,
		created_at: r.created_at.toISOString(),
	}));
}

async function basePlanKey(orgId: string): Promise<string | null> {
	const row = await db.org_entitlement.findUnique({
		where: { organization_id: orgId },
		select: { plan_version: { select: { plan_key: true } } },
	});
	return row?.plan_version.plan_key ?? null;
}

export async function fileRequest(
	orgId: string,
	by: { id: string; name: string },
	input: { planKey?: string; modules?: string[]; note?: string },
): Promise<RequestView> {
	const note = input.note?.trim() || null;
	const modules = [...new Set(input.modules ?? [])];
	if (input.planKey) {
		const plan = await db.plan.findUnique({
			where: { key: input.planKey },
		});
		if (!plan || !plan.assignable || plan.archived_at)
			throw badRequest("That subscription is not available");
		if (plan.key === (await basePlanKey(orgId)))
			throw badRequest("You are already on this subscription");
	}
	if (modules.length) {
		const ent = await getEntitlements(orgId);
		for (const m of modules) {
			const def = getModule(m);
			if (
				!def ||
				def.kind !== "plan_gated" ||
				ent.modules[m] !== "not_in_plan"
			)
				throw badRequest(
					`${def?.label ?? m} is not available to request`,
				);
		}
	}
	if (!input.planKey && !modules.length && (!note || note.length < 3))
		throw badRequest("Tell us what you need (3 characters or more)");
	try {
		const created = await db.$transaction(async (tx) => {
			const row = await tx.upgrade_request.create({
				data: {
					organization_id: orgId,
					requested_by_id: by.id,
					requested_by_name: by.name,
					requested_plan_key: input.planKey ?? null,
					requested_modules: modules,
					note,
				},
			});
			await tx.log.create({
				data: {
					organization_id: orgId,
					event_type: "upgrade_request.created",
					action: "created",
					entity_type: "upgrade_request",
					entity_id: row.id,
					actor_type: "dispatcher",
					actor_id: by.id,
					actor_name: by.name,
					changes: {
						requested: {
							old: null,
							new: { plan: input.planKey ?? null, modules, note },
						},
					},
				},
			});
			return row;
		});
		return (await toViews([created]))[0];
	} catch (err) {
		if (isUniqueViolation(err))
			throw httpError(
				409,
				ErrorCodes.REQUEST_OPEN,
				"You already have an open request",
			);
		throw err;
	}
}

export async function listOwnRequests(orgId: string): Promise<RequestView[]> {
	return toViews(
		await db.upgrade_request.findMany({
			where: { organization_id: orgId },
			orderBy: { created_at: "desc" },
			take: 20,
		}),
	);
}

export async function withdrawRequest(
	orgId: string,
	id: string,
	by: { id: string; name: string },
) {
	await db.$transaction((tx) =>
		closeRequestTx(tx, { id, orgId }, "withdrawn", {
			type: "dispatcher",
			...by,
		}),
	);
}

export async function requestableTiers(orgId: string) {
	const current = await basePlanKey(orgId);
	const plans = await db.plan.findMany({
		where: {
			assignable: true,
			archived_at: null,
			...(current && { key: { not: current } }),
		},
		orderBy: { key: "asc" },
		select: {
			key: true,
			label: true,
			versions: {
				orderBy: { version: "desc" },
				take: 1,
				select: { modules: true },
			},
		},
	});
	return plans.map((p) => ({
		key: p.key,
		label: p.label,
		modules: (p.versions[0]?.modules ?? [])
			.filter((m) => getModule(m)?.kind === "plan_gated")
			.map(moduleRef),
	}));
}

const PAGE = 50;

export async function listRequests(q: {
	status: "open" | "all";
	orgId?: string;
	page: number;
}) {
	const where = {
		...(q.status === "open" && { status: "open" }),
		...(q.orgId && { organization_id: q.orgId }),
	};
	const [total, rows] = await Promise.all([
		db.upgrade_request.count({ where }),
		db.upgrade_request.findMany({
			where,
			orderBy: { created_at: "desc" },
			skip: (q.page - 1) * PAGE,
			take: PAGE,
			include: { organization: { select: { name: true } } },
		}),
	]);
	const views = await toViews(rows.map(({ organization: _o, ...r }) => r));
	return {
		rows: views.map((v, i) => ({
			...v,
			org_name: rows[i].organization.name,
		})),
		total,
		page: q.page,
		pageSize: PAGE,
	};
}

export const openRequestCount = () =>
	db.upgrade_request.count({ where: { status: "open" } });

async function findRequest(id: string) {
	const row = await db.upgrade_request.findUnique({ where: { id } });
	if (!row) throw httpError(404, ErrorCodes.NOT_FOUND, "Request not found");
	return row;
}

async function closeByStaff(
	actor: StaffActor,
	row: { id: string; organization_id: string },
	status: "approved" | "declined",
	note: string,
) {
	const { id } = row;
	await db.$transaction((tx) =>
		closeRequestTx(
			tx,
			{ id, orgId: row.organization_id },
			status,
			{ type: "platform_staff", id: actor.id, name: STAFF_ACTOR_NAME },
			note,
		),
	);
	// Nothing in the entitlements changed, but the customer's subscription rail refreshes its
	// request status on this event.
	try {
		emitToOrg(row.organization_id, "entitlements:changed", {});
	} catch (err) {
		log.warn({ err, id }, "entitlements:changed emit failed");
	}
	await notifyRequestResolved(row.organization_id, id, status, note);
}

export const declineRequest = async (
	actor: StaffActor,
	id: string,
	note: string,
) => closeByStaff(actor, await findRequest(id), "declined", note);

export async function approveSatisfied(
	actor: StaffActor,
	id: string,
	note: string,
) {
	const row = await findRequest(id);
	if (row.status !== "open") throw requestClosed();
	const [base, ent] = await Promise.all([
		basePlanKey(row.organization_id),
		getEntitlements(row.organization_id),
	]);
	const tierOk = !row.requested_plan_key || row.requested_plan_key === base;
	const modulesOk = row.requested_modules.every(
		(m) => ent.modules[m] === "on",
	);
	if (!tierOk || !modulesOk)
		throw badRequest("Apply the requested change first");
	await closeByStaff(actor, row, "approved", note);
}
