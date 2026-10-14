import { ZodError } from "zod";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { log } from "../services/appLogger.js";
import { logActivity } from "../services/logger.js";
import { sendEmailVerificationEmail } from "../services/emailService.js";
import { registerOrganizationSchema } from "../lib/validate/organizations.js";
import { 
	createOrgRoleSchema, 
	updateOrgRoleSchema,
	assignOrgRoleSchema,
	permissionsOutsideTier,
	tierPermissionMessage,
} from "../lib/validate/organizationRoles.js";
import { db } from '../db.js';
import { getScopedDb, UserContext } from "../lib/context.js";
import {
	EMAIL_IN_USE,
	loginEmailTaken,
	provisionOrganization,
	signupPlanVersionId,
} from "../services/provisionOrganization.js";
import { isUniqueViolation } from "../platform/errors.js";

export { defaultDispatcherPermissions } from "../services/provisionOrganization.js";

export const registerOrganization = async (data: unknown) => {
	try {
		const parsed = registerOrganizationSchema.parse(data);
		// all emails in db are set to lower case
		parsed.admin_email = parsed.admin_email.toLowerCase();
		// DB since it has to compare with other orgs
		if (await loginEmailTaken(parsed.admin_email)) return { err: EMAIL_IN_USE };

		const planVersionId = await signupPlanVersionId();
		const hashedPassword = await bcrypt.hash(parsed.admin_password, 10);
		const verificationToken = randomUUID();

		const result = await db.$transaction((tx) =>
			provisionOrganization(tx, {
				org: {
					name: parsed.org_name,
					email: parsed.admin_email,
					phone: parsed.org_phone ?? parsed.admin_phone ?? null,
					address: parsed.org_address ?? null,
					website: parsed.org_website || null,
					timezone: parsed.org_timezone,
					tax_rate: parsed.org_tax_rate,
				},
				admin: {
					name: parsed.admin_name,
					email: parsed.admin_email,
					phone: parsed.admin_phone ?? null,
					password: hashedPassword,
					verificationToken,
				},
				businessType: parsed.business_type,
				planVersionId,
				source: "signup",
			}),
		);

		sendEmailVerificationEmail(result.adminEmail, verificationToken);

		await logActivity({
			event_type: "organization.created",
			action: "created",
			entity_type: "organization",
			entity_id: result.orgId,
			organization_id: result.orgId,
			actor_type: "system",
		});

		return {
			err: "",
			item: {
				org: { id: result.orgId, name: parsed.org_name },
				admin: { id: result.adminId, name: parsed.admin_name, email: result.adminEmail },
			},
		};
	} catch (e) {
		// Status-carrying errors (paused signups, bad business type) go to the route as-is.
		if (e && typeof e === "object" && "statusCode" in e) throw e;
		// A parallel signup took the email between the check above and the insert.
		if (isUniqueViolation(e)) return { err: EMAIL_IN_USE };
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Error registering organization");
		return { err: "Internal server error" };
	}
};

export const getOrgRoles = async (organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const roles = await sdb.organization_role.findMany({
			where: { organization_id: organizationId },
			include: { _count: { select: { dispatchers: true, technicians: true } } },
		});
		return { err: "", items: roles };
	}catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error getting organization roles");
		return { err: "Internal server error" };
	}
}

export const getOrgRoleById = async (id: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const role = await sdb.organization_role.findFirst({
			// redundant or extra secure 🤔
			where: { id, organization_id: organizationId },
			include: { _count: { select: { dispatchers: true, technicians: true } } },
		});
		if (!role) {
			return { err: "Role not found" };
		}
		return { err: "", item: role };
	}catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error getting organization role");
		return { err: "Internal server error" };
	}
}

export const createOrgRole = async (
	data: unknown, 
	organizationId: string, 	
	context?: UserContext
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const { name, base_tier, permissions, is_default } = createOrgRoleSchema.parse(data);

		const existing = await sdb.organization_role.findFirst({
			where: { name, organization_id: organizationId },
		});
		if (existing) {
			return { err: "A role with this name already exists" };
		}

		const role = await sdb.$transaction(async (tx) => {
			if (is_default) {
				await tx.organization_role.updateMany({
					where: { organization_id: organizationId, base_tier },
					data: { is_default: false },
				});
			}
			return tx.organization_role.create({
				data: {
					name,
					base_tier,
					permissions,
					is_default,
					organization_id: organizationId,
				},
			});
		});

		await logActivity({
			event_type: "organization_role.created",
			action: "created",
			entity_type: "organization_role",
			entity_id: role.id,
			organization_id: organizationId,
			actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				name: { old: null, new: role.name },
				base_tier: { old: null, new: role.base_tier },
				permissions: { old: null, new: role.permissions },
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: role };
	}catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error creating organization role");
		return { err: "Internal server error" };
	}
}

export const updateOrgRole = async (
   id: string,
   data: unknown,
   organizationId: string,
   context?: UserContext
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.organization_role.findFirst({
			where: { id, organization_id: organizationId },
		});
		if (!existing) {
			return { err: "Role not found" };
		}
		
		const { name, base_tier, permissions, is_default } = updateOrgRoleSchema.parse(data);
		// The update schema cannot see the stored tier, so the tier check that
		// createOrgRoleSchema runs happens here.
		if (permissions !== undefined || base_tier !== undefined) {
			const tier = (base_tier ?? existing.base_tier) as "dispatcher" | "technician";
			const outside = permissionsOutsideTier(tier, permissions ?? existing.permissions);
			if (outside.length > 0) {
				return { err: `Validation failed: ${tierPermissionMessage(tier, outside)}` };
			}
		}
		if (name) {
			const nameConflict = await sdb.organization_role.findFirst({
				where: { name, organization_id: organizationId, NOT: { id } },
			});
			if (nameConflict) {
				return { err: "A role with this name already exists" };
			}
		}

		const effectiveTier = base_tier ?? existing.base_tier;
		const updated = await sdb.$transaction(async (tx) => {
			// Clear is_default from other roles of the same tier before setting this one
			if (is_default === true) {
				await tx.organization_role.updateMany({
					where: { organization_id: organizationId, base_tier: effectiveTier, NOT: { id } },
					data: { is_default: false },
				});
			}
			return tx.organization_role.update({
				where: { id },
				data: {
					name: name ?? existing.name,
					base_tier: effectiveTier,
					permissions: permissions ?? existing.permissions,
					...(is_default !== undefined && { is_default }),
				},
			});
		});
		
		const changes = {
			name: { old: existing.name, new: updated.name },
			base_tier: { old: existing.base_tier, new: updated.base_tier },
			permissions: { old: existing.permissions, new: updated.permissions },
		};

		await logActivity({
			event_type: "organization_role.updated",
			action: "updated",
			entity_type: "organization_role",
			entity_id: id,
			organization_id: organizationId,
			actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes,
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: updated };
	}catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error updating organization role");
		return { err: "Internal server error" };
	}
}

export const deleteOrgRole = async (
   id: string,
   organizationId: string,
   context?: UserContext
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.organization_role.findFirst({
			where: { id, organization_id: organizationId },
		});
		if (!existing) {
			return { err: "Role not found" };
		}

		const updated = await sdb.$transaction(async (tx) => {
			await tx.organization_role.delete({
				where: { id },
			});

			const changes = {
				name: { old: existing.name, new: null },
				base_tier: { old: existing.base_tier, new: null },
				permissions: { old: existing.permissions, new: null },
			};

			await logActivity({
				event_type: "organization_role.deleted",
				action: "deleted",
				entity_type: "organization_role",
				entity_id: id,
				organization_id: organizationId,	
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes,
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return existing; // Return the deleted role's data for response
		});

		return { err: "", item: updated };
	}catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error deleting organization role");
		return { err: "Internal server error" };
	}
}

export const assignOrgRole = async (
	userId: string,
	userType: "dispatcher" | "technician",
	roleId: string | null, // null to remove role
	organizationId: string,
	context?: UserContext
) => {
	try {
		const sdb = getScopedDb(organizationId);

		const role = roleId ? await sdb.organization_role.findFirst({
			where: { id: roleId, organization_id: organizationId },
		}) : null;
		if (roleId && !role) {
			return { err: "Role not found" };
		}
		if (role && role.base_tier !== userType) {
			return {
				err: `Role "${role.name}" is a ${role.base_tier} role and cannot be assigned to a ${userType}`,
			};
		}

		const targetUser = userType === "technician"
			? await sdb.technician.findFirst({ where: { id: userId } })
			: await sdb.dispatcher.findFirst({ where: { id: userId } });
		if (!targetUser) {
			return { err: "User not found" };
		}

	 	const updated = await sdb.$transaction(async (tx) => {
			if (userType === "technician") {
				await tx.technician.update({
					where: { id: userId },
					data: { organization_role_id: roleId },
				});
			} else if (userType === "dispatcher") {
				await tx.dispatcher.update({
					where: { id: userId },
					data: { organization_role_id: roleId },
				});
			} else {
				return { err: "Invalid user type" };
			}

			const changes = {
				organization_role_id: {
					old: targetUser.organization_role_id ?? null,
					new: roleId,
				},
			};

			await logActivity({
				event_type: "organization_role.assigned",
				action: roleId ? "assigned" : "removed",
				entity_type: "organization_role_assignment",
				entity_id: userId,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes,
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

		 // Return the updated user with role info for response
			const updatedUser = userType === "technician"
				? await tx.technician.findFirst({ where: { id: userId } })
				: await tx.dispatcher.findFirst({ where: { id: userId } });

			return updatedUser;
		});

		return { err: "", item: updated };
	}catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error assigning organization role");
		return { err: "Internal server error" };
	}
}