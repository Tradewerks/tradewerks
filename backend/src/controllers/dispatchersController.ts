import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { Prisma } from "../../generated/prisma/client.js";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import {
    createDispatcherSchema,
    updateDispatcherSchema,
    changePasswordSchema
} from "../lib/validate/dispatchers.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { log } from "../services/appLogger.js";
import { sendEmailVerificationEmail } from "../services/emailService.js";
import { getAllPermissions } from "../lib/permissionCatalogs.js";
import { getMfaEnabledUserIds, isMfaEnabled } from "../services/mfaService.js";
import { db } from "../db.js"
import { assertSeatAvailable } from "../lib/entitlements/seats.js";
import type { HttpError } from "../types/responses.js";
import { setUserActive } from "../services/userActiveCache.js";
import { getSocket } from "../services/socketService.js";

export const getAllDispatchers = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
    const dispatchers = await sdb.dispatcher.findMany({
        include: {
            organization_role: { select: { id: true, name: true } },
        },
    });
    const mfaEnabledIds = await getMfaEnabledUserIds(dispatchers.map((d) => d.id));
    return dispatchers.map((d) => ({ ...d, mfaEnabled: mfaEnabledIds.has(d.id) }));
};

export const getDispatcherById = async (id: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
    const dispatcher = await sdb.dispatcher.findFirst({
        where: { id },
        include: {
            organization_role: { select: { id: true, name: true, permissions: true } },
            _count: {
                select: {
                    created_quotes: true,
                    created_invoices: true,
                    created_requests: true,
                    created_recurring_plans: true,
                    managed_projects: true,
                }
            }
        },
        
    });
    if (!dispatcher) return null;
    const permissions: string[] =
        dispatcher.role === "admin"
            ? getAllPermissions("dispatcher")
            : (dispatcher.organization_role?.permissions as string[] | null) ?? [];
    return { ...dispatcher, permissions, mfaEnabled: await isMfaEnabled(id) };
};

export const insertDispatcher = async (
    data: unknown,
    organizationId: string,
    context?: UserContext
) => {
    try {
        const parsed = createDispatcherSchema.parse(data);
        const passwordProvided = parsed.password ? true : false;
        // all emails in db are set to lower case
        parsed.email = parsed.email.toLowerCase();
        const sdb = getScopedDb(organizationId);
        const existing = (await db.technician.findFirst({ where: { email: parsed.email } })) ??
                         (await db.dispatcher.findFirst({ where: { email: parsed.email } }));

        if (existing) {
            return { err: "Email already exists" };
        }
        // if no password provided, generate a random one and email it to them
        const tempPassword = passwordProvided ? parsed.password! : randomBytes(8).toString("hex") + "A1!";
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        // Kept locally: the created row comes back with credential columns
        // omitted (see SECRET_FIELD_OMIT in db.ts), and the token must not be
        // echoed in the API response anyway.
        const emailVerificationToken = randomUUID();
        const created = await sdb.$transaction(async (tx) => {
            await assertSeatAvailable(tx, organizationId, "dispatchers");
            const { password: _pw, ...parsedWithoutPassword } = parsed;
            const dispatcher = await tx.dispatcher.create({
                data: {
                    ...parsedWithoutPassword,
                    organization_id: organizationId,
                    password: hashedPassword,
                    email_verification_token: emailVerificationToken,
                    // if password provided dispatcher doesn't need to reset password on first login
                    ...(passwordProvided && { last_login: new Date() }),
                },
            });

            await logActivity({
                event_type: "dispatcher.created",
                action: "created",
                entity_type: "dispatcher",
                entity_id: dispatcher.id,
                organization_id: organizationId,
                actor_type: context?.techId
                    ? "technician"
                    : context?.dispatcherId
                    ? "dispatcher"
                    : "system",
                actor_id: context?.techId || context?.dispatcherId,
                changes: {
                    name: { old: null, new: dispatcher.name },
                    email: { old: null, new: dispatcher.email },
                    phone: { old: null, new: dispatcher.phone },
                    title: { old: null, new: dispatcher.title },
                },
                ip_address: context?.ipAddress,
                user_agent: context?.userAgent,
            });

            sendEmailVerificationEmail(
                dispatcher.email, 
                emailVerificationToken, 
                passwordProvided ? undefined : tempPassword
            );

            return dispatcher;
        });

        return { err: "", item: created };
    } catch (e) {
        if ((e as HttpError).statusCode) throw e;
        if (e instanceof ZodError) {
            return {
                err: `Validation failed: ${e.issues
                    .map((err) => err.message)
                    .join(", ")}`,
            };
        }
        log.error({ err: e }, "Error inserting dispatcher");
        return { err: "Internal server error" };
    }
};

export const updateDispatcher = async (
    id : string,
    data: unknown,
    organizationId: string,
    context?: UserContext
) => {
    try {
        const parsed = updateDispatcherSchema.parse(data);
        // all emails in db are set to lower case
        if (parsed.email) parsed.email = parsed.email.toLowerCase();

        const sdb = getScopedDb(organizationId);
        const existing = await sdb.dispatcher.findFirst({
            where: { id },
        });

        if (!existing) {
            return { err: "Dispatcher not found" };
        }

        if (parsed.email && parsed.email !== existing.email) {
            const emailTaken =
                (await db.technician.findFirst({ where: { email: parsed.email } })) ??
                (await db.dispatcher.findFirst({ where: { email: parsed.email } }));

            if (emailTaken) {
                return { err: "Email already exists" };
            }
        }

        const changes = buildChanges(existing, parsed, [
            "organization_id",
            "name",
            "email",
            "phone",
            "title",
            "description",
            "role",
            "last_login",
            "theme",
        ] as const);

        const { report_layout, dashboard_layout, kpi_layout, ...rest } = parsed;
        const updated = await sdb.$transaction(async (tx) => {
            const dispatcher = await tx.dispatcher.update({
                where: { id },
                data: {
                    ...rest,
                    ...(report_layout !== undefined && {
                        report_layout:
                            report_layout === null
                                ? Prisma.JsonNull
                                : (report_layout as Prisma.InputJsonValue),
                    }),
                    ...(dashboard_layout !== undefined && {
                        dashboard_layout:
                            dashboard_layout === null
                                ? Prisma.JsonNull
                                : (dashboard_layout as Prisma.InputJsonValue),
                    }),
                    ...(kpi_layout !== undefined && {
                        kpi_layout:
                            kpi_layout === null
                                ? Prisma.JsonNull
                                : (kpi_layout as Prisma.InputJsonValue),
                    }),
                } as Prisma.dispatcherUncheckedUpdateInput,
                include: {
                    // Nothing needed to be included for now
                },
            });

            if (Object.keys(changes).length > 0) {
                await logActivity({
                    event_type: "dispatcher.updated",
                    action: "updated",
                    entity_type: "dispatcher",
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
            }

            return dispatcher;
        });

        return { err: "", item: updated };
    } catch (e) {
        if (e instanceof ZodError) {
            return {
                err: `Validation failed: ${e.issues
                    .map((err) => err.message)
                    .join(", ")}`,
            };
        }
        log.error({ err: e }, "Error updating dispatcher");
        return { err: "Internal server error" };
    }
};

export const deleteDispatcher = async (id: string, organization_id: string, context?: UserContext) => {
    try {
        if (context?.dispatcherId === id) return { err: "You can't delete your own account"}
        const sdb = getScopedDb(organization_id);
        const user = await sdb.dispatcher.findFirst({
            where: { id },
        });

        if (!user) {
            return { err: "Dispatcher not found" };
        }
        if (user.role === "admin") {
            return { err: "The organization admin can't be deleted"}
        }

        await sdb.$transaction(async (tx) => {
            await tx.dispatcher.delete({
                where: { id },
            });

            await logActivity({
                event_type: "dispatcher.deleted",
                action: "deleted",
                entity_type: "dispatcher",
                entity_id: id,
                organization_id: organization_id,
                actor_type: context?.techId
                    ? "technician"
                    : context?.dispatcherId
                    ? "dispatcher"
                    : "system",
                actor_id: context?.techId || context?.dispatcherId,
                changes: {
                    name: { old: user.name, new: null },
                    email: { old: user.email, new: null },
                    phone: { old: user.phone, new: null },
                    title: { old: user.title, new: null },
                },
                ip_address: context?.ipAddress,
                user_agent: context?.userAgent,
            });
        });

        return { message: "Dispatcher deleted successfully" };
    } catch (error) {
        log.error({ err: error }, "Error deleting dispatcher");
        return { err: "Internal server error" };
    }
};

export const changeDispatcherPassword = async (
    id: string, 
    organization_id: string, 
    data: unknown, 
    context?: UserContext
) => {
    const parsed = changePasswordSchema.parse(data);
    const sdb = getScopedDb(organization_id);
    // password is omitted globally (db.ts); opt back in here to verify the current one.
    const dispatcher = await sdb.dispatcher.findFirst({
        where: { id },
        omit: { password: false },
    });

    if (!dispatcher) {
        return { err: "Dispatcher not found" };
    }

    const valid = await bcrypt.compare(parsed.current_password, dispatcher.password);
    if (!valid) {
        return { err: "Current password is incorrect" };
    }
    const hashedPassword = await bcrypt.hash(parsed.new_password, 10);
    await sdb.$transaction(async (tx) => {
        await tx.dispatcher.update({
            where: { id },
            data: {
                password: hashedPassword,
            },
        });

        await logActivity({
            event_type: "dispatcher.password.changed",
            action: "changed",
            entity_type: "dispatcher",
            entity_id: id,
            organization_id: organization_id,
            actor_type: context?.techId
                ? "technician"
                : context?.dispatcherId
                ? "dispatcher"
                : "system",
            actor_id: context?.techId || context?.dispatcherId,
            // Never persist hashes in the audit trail — they are readable by anyone
            // with view_dispatchers via the change-history endpoints.
            changes: {
                password: { old: "[hashed]", new: "[hashed]" },
            },
            ip_address: context?.ipAddress,
            user_agent: context?.userAgent,
        });
    });
    return { message: "Password updated successfully", err: ""};
};

export const deactivateDispatcher = async (id: string, organizationId: string, context?: UserContext) => {
    const sdb = getScopedDb(organizationId);
    const existing = await sdb.dispatcher.findFirst({ where: { id } });
    if (!existing) return { err: "Dispatcher not found" };
    if (existing.deactivated_at) return { err: `${existing.name} is already deactivated.` };
    if (context?.dispatcherId === id) return { err: "You can't deactivate your own account." };
    if (existing.role === "admin") {
        const admins = await sdb.dispatcher.count({
            where: { organization_id: organizationId, role: "admin", deactivated_at: null },
        });
        if (admins <= 1) return { err: `${existing.name} is the only active admin. Make someone else an admin first.` };
    }

    const item = await sdb.$transaction(async (tx) => {
        const updated = await tx.dispatcher.update({ where: { id }, data: { deactivated_at: new Date() } });
        await tx.jwt_refresh_token.deleteMany({ where: { userId: id } });
        await logActivity({
            event_type: "dispatcher.deactivated",
            action: "updated",
            entity_type: "dispatcher",
            entity_id: id,
            organization_id: organizationId,
            actor_type: context?.techId ? "technician" : context?.dispatcherId ? "dispatcher" : "system",
            actor_id: context?.techId || context?.dispatcherId,
            changes: { deactivated_at: { old: null, new: updated.deactivated_at } },
            ip_address: context?.ipAddress,
            user_agent: context?.userAgent,
        });
        return updated;
    });

    setUserActive(id, false);
    try {
        getSocket().in(`dispatcher:${id}`).disconnectSockets(true);
    } catch (err) {
        log.warn({ err, id }, "deactivated dispatcher's socket not disconnected");
    }
    return { err: "", item };
};

export const reactivateDispatcher = async (id: string, organizationId: string, context?: UserContext) => {
    const sdb = getScopedDb(organizationId);
    const existing = await sdb.dispatcher.findFirst({ where: { id } });
    if (!existing) return { err: "Dispatcher not found" };
    if (!existing.deactivated_at) return { err: `${existing.name} is already active.` };

    const item = await sdb.$transaction(async (tx) => {
        await assertSeatAvailable(tx, organizationId, "dispatchers");
        const updated = await tx.dispatcher.update({ where: { id }, data: { deactivated_at: null } });
        await logActivity({
            event_type: "dispatcher.reactivated",
            action: "updated",
            entity_type: "dispatcher",
            entity_id: id,
            organization_id: organizationId,
            actor_type: context?.techId ? "technician" : context?.dispatcherId ? "dispatcher" : "system",
            actor_id: context?.techId || context?.dispatcherId,
            changes: { deactivated_at: { old: existing.deactivated_at, new: null } },
            ip_address: context?.ipAddress,
            user_agent: context?.userAgent,
        });
        return updated;
    });
    setUserActive(id, true);
    return { err: "", item };
};