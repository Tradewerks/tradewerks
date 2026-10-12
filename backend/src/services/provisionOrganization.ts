import type { Prisma } from "../../generated/prisma/client.js";
import { db } from "../db.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { getAllPermissions } from "../lib/permissionCatalogs.js";
import { getBusinessType } from "../lib/entitlements/businessTypes.js";

export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

// Administration stays with the Administrator role. Resolving and conceding
// disputes are withheld for the reason the dispute-role migration grants them
// only to administrators, and resolve_own_disputes is an owner's decision, never
// a default. refund_invoices stays: this template holds edit_invoices, and the
// migration grants refund_invoices to every such role.
const DEFAULT_DISPATCHER_WITHHELD = new Set([
	"manage_roles",
	"view_admin",
	"manage_organization",
	"manage_dispatchers",
	"resolve_disputes",
	"concede_disputes",
	"resolve_own_disputes",
]);

export function defaultDispatcherPermissions(): string[] {
	return getAllPermissions("dispatcher").filter((p) => !DEFAULT_DISPATCHER_WITHHELD.has(p));
}

export interface ProvisionInput {
	org: {
		name: string;
		email: string;
		phone?: string | null;
		address?: string | null;
		website?: string | null;
		timezone?: string;
		tax_rate?: number;
	};
	admin: {
		name: string;
		email: string;
		phone?: string | null;
		// Always a bcrypt hash; staff-created admins get a hash of random bytes plus `invite`.
		password: string;
		verificationToken?: string;
		invite?: { hash: string; expires: Date };
	};
	businessType: string;
	planVersionId: string;
	trial?: { planVersionId: string; endsAt: Date };
	source: "signup" | "operator";
}

export const EMAIL_IN_USE = "An account with this email already exists";

// Both tables: login looks up technicians first, so a shared email would never reach this admin.
// A parallel create that slips past this check hits the dispatcher email index (P2002).
export async function loginEmailTaken(email: string): Promise<boolean> {
	return !!(
		(await db.technician.findFirst({ where: { email }, select: { id: true } })) ??
		(await db.dispatcher.findUnique({ where: { email }, select: { id: true } }))
	);
}

export async function latestVersionId(plan: Prisma.planWhereInput): Promise<string | null> {
	const v = await db.plan_version.findFirst({
		where: { plan },
		orderBy: { version: "desc" },
		select: { id: true },
	});
	return v?.id ?? null;
}

export async function signupPlanVersionId(): Promise<string> {
	const id = await latestVersionId({ is_signup_default: true, archived_at: null });
	// Never fall back to Legacy: it is unlimited, and a signup must cost nothing (spec D3).
	if (!id)
		throw httpError(503, ErrorCodes.SIGNUPS_PAUSED, "Signups are paused. Contact TradeWerks.");
	return id;
}

export async function provisionOrganization(tx: Tx, input: ProvisionInput) {
	const type = getBusinessType(input.businessType);
	if (!type) throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Choose a business type");

	const org = await tx.organization.create({
		data: {
			name: input.org.name,
			email: input.org.email,
			phone: input.org.phone ?? null,
			address: input.org.address ?? null,
			website: input.org.website || null,
			timezone: input.org.timezone ?? "America/Chicago",
			tax_rate: input.org.tax_rate ?? 0,
		},
	});

	await tx.org_entitlement.create({
		data: {
			organization_id: org.id,
			plan_version_id: input.planVersionId,
			plan_source: input.source,
			template_key: type.key,
			module_choices: type.moduleDefaults,
			modules_reviewed_at: null,
			...(input.trial && {
				trial_plan_version_id: input.trial.planVersionId,
				trial_ends_at: input.trial.endsAt,
			}),
		},
	});

	// default organization roles — full access derived from catalog
	await tx.organization_role.createMany({
		data: [
			{
				organization_id: org.id,
				name: "Default Dispatcher",
				base_tier: "dispatcher",
				permissions: defaultDispatcherPermissions(),
				is_default: true,
			},
			{
				organization_id: org.id,
				name: "Default Technician",
				base_tier: "technician",
				permissions: getAllPermissions("technician"),
				is_default: true,
			},
		],
	});
	// admin role with all permissions
	const adminRole = await tx.organization_role.create({
		data: {
			organization_id: org.id,
			name: "Administrator",
			base_tier: "dispatcher",
			permissions: getAllPermissions("dispatcher"),
			is_default: false,
		},
	});

	const admin = await tx.dispatcher.create({
		data: {
			organization_id: org.id,
			name: input.admin.name,
			email: input.admin.email,
			phone: input.admin.phone ?? null,
			password: input.admin.password,
			role: "admin",
			title: "Administrator",
			description: "",
			email_verification_token: input.admin.verificationToken ?? null,
			invite_token_hash: input.admin.invite?.hash ?? null,
			invite_expires_at: input.admin.invite?.expires ?? null,
			last_login: input.admin.invite ? null : new Date(),
			organization_role_id: adminRole.id,
		},
	});
	return { orgId: org.id, adminId: admin.id, adminEmail: admin.email, timezone: org.timezone };
}
