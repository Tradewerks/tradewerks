import z from "zod";
import { getAllPermissions, type PermissionTier } from "../permissionCatalogs.js";

const BaseTier = z.enum(["dispatcher", "technician"]);

/**
 * Permission strings the tier's catalog does not define, or []. A role holding
 * another tier's permission is not inert: a technician role carrying dispute
 * grants reaches the dispute routes as a caller separation of duties cannot
 * identify.
 */
export function permissionsOutsideTier(tier: PermissionTier, permissions: readonly string[]): string[] {
    const catalog = new Set(getAllPermissions(tier));
    return permissions.filter((permission) => !catalog.has(permission));
}

export const tierPermissionMessage = (tier: PermissionTier, outside: readonly string[]) =>
    `Not ${tier} permissions: ${outside.join(", ")}`;

export const createOrgRoleSchema = z.object({
    name: z.string().min(1, "Role name is required"),
    base_tier: BaseTier,
    permissions: z.array(z.string()).default([]),
    is_default: z.boolean().default(false),
}).superRefine((data, ctx) => {
    const outside = permissionsOutsideTier(data.base_tier, data.permissions);
    if (outside.length > 0) {
        ctx.addIssue({
            code: "custom",
            path: ["permissions"],
            message: tierPermissionMessage(data.base_tier, outside),
        });
    }
});

export const updateOrgRoleSchema = z.object({
    name: z.string().min(1, "Role name is required").optional(),
    base_tier: BaseTier.optional(),
    permissions: z.array(z.string()).optional(),
    is_default: z.boolean().optional(),
}).refine(
    (data) => data.name !== undefined || data.base_tier !== undefined || data.permissions !== undefined || data.is_default !== undefined,
    { message: "At least one field must be provided for update" }
);

export const assignOrgRoleSchema = z.object({
    user_id: z.string().uuid("Valid user ID is required"),
    user_type: z.enum(["dispatcher", "technician"]),
    role_id: z.string().uuid("Valid role ID is required").nullable(), // null to remove role
});

export type CreateOrgRoleInput = z.infer<typeof createOrgRoleSchema>;
export type UpdateOrgRoleInput = z.infer<typeof updateOrgRoleSchema>;   
export type AssignOrgRoleInput = z.infer<typeof assignOrgRoleSchema>;