import { z, ZodError } from "zod";
import { coordsSchema } from "../lib/validate/shared.js";
import type {
	tech_break_reason,
	technician_status,
} from "../../generated/prisma/client.js";
import {
	createTechnicianSchema,
	updateTechnicianSchema,
	changePasswordSchema,
} from "../lib/validate/technicians.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { log } from "../services/appLogger.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { sendEmailVerificationEmail } from "../services/emailService.js";
import { getMfaEnabledUserIds, isMfaEnabled } from "../services/mfaService.js";
import { db } from "../db.js";
import { utcDayRange } from "../lib/dayRange.js";
import { fetchRouteDistanceMiles, applyOdometerIncrement } from "../lib/vehicleMileage.js";
import { isWeekLocked, TIMESHEET_LOCKED } from "./timesheetController.js";
import { recordDrive } from "../lib/visitDrive.js";

const PAID_BREAK_REASONS = new Set<string>(["Rest", "EquipmentIssue"]);
const VALID_BREAK_REASONS = new Set<string>([
	"Lunch",
	"Rest",
	"EquipmentIssue",
	"Other",
]);
const VALID_TECH_STATUSES = new Set<string>([
	"Offline",
	"Available",
	"Break",
	"EnRoute",
	"OnSite",
	"Working",
	"Paused",
	"WrappingUp",
	"HeadingBack",
]);

function toBreakReason(v: string): tech_break_reason | undefined {
	if (!VALID_BREAK_REASONS.has(v)) return undefined;
	return v as tech_break_reason;
}

function toTechnicianStatus(v: string): technician_status | undefined {
	if (!VALID_TECH_STATUSES.has(v)) return undefined;
	return v as technician_status;
}

/*
 * Omit sensitive fields from technician records returned
 * Deliberately withheld: password, hourly_rate, password_reset_token, password_reset_token_expires_at, cost_rate
 */
const TECHNICIAN_SELECT = {
	id: true,
	organization_id: true,
	name: true,
	email: true,
	phone: true,
	title: true,
	description: true,
	status: true,
	hire_date: true,
	coords: true,
	last_ping_at: true,
	last_login: true,
	theme: true,
	organization_role_id: true,
	current_vehicle_id: true,
	current_vehicle: { select: { id: true, name: true, stored_at_coords: true } },
	organization_role: { select: { id: true, name: true, permissions: true } },
	visit_techs: {
		include: {
			visit: {
				include: {
					job: { include: { client: true } },
				},
			},
		},
	},
} as const;

export const getAllTechnicians = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const technicians = await sdb.technician.findMany({
		select: TECHNICIAN_SELECT,
	});
	const mfaEnabledIds = await getMfaEnabledUserIds(technicians.map((t) => t.id));
	return technicians.map((t) => ({
		...t,
		permissions: (t.organization_role?.permissions as string[] | null) ?? [],
		mfaEnabled: mfaEnabledIds.has(t.id),
	}));
};

export const getTechnicianById = async (id: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const technician = await sdb.technician.findFirst({
		where: { id },
		select: TECHNICIAN_SELECT,
	});
	if (!technician) return null;
	const permissions: string[] = (technician.organization_role?.permissions as string[] | null) ?? [];
	return { ...technician, permissions, mfaEnabled: await isMfaEnabled(id) };
};

export const insertTechnician = async (
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createTechnicianSchema.parse(data);
		// all emails in db are set to lower case
        parsed.email = parsed.email.toLowerCase();
		const sdb = getScopedDb(organizationId);

		const existing = (await db.technician.findFirst({ where: { email: parsed.email } })) ??
						 (await db.dispatcher.findFirst({ where: { email: parsed.email } }));

		if (existing) {
			return { err: "Email already exists" };
		}

		const passwordProvided = parsed.password ? true : false;
		const tempPassword =
			parsed.password ?? randomBytes(8).toString("hex") + "A1!";
		const hashedPassword = await bcrypt.hash(tempPassword, 10);

		const created = await sdb.$transaction(async (tx) => {
			const { password: _pw, ...parsedWithoutPassword } = parsed;
			const technician = await tx.technician.create({
				data: {
					...parsedWithoutPassword,
					organization_id: organizationId,
					password: hashedPassword,
					...(passwordProvided && { last_login: new Date() }),
				},
				include: {
					visit_techs: {
						include: {
							visit: {
								include: {
									job: { include: { client: true } },
								},
							},
						},
					},
				},
			});

			// Don't worry about this right now since main doesn't have working emails
			/*sendEmailVerificationEmail(
				technician.email, 
				technician.email_verification_token!, 
				passwordProvided ? undefined : tempPassword
			);*/

			await logActivity({
				event_type: "technician.created",
				action: "created",
				entity_type: "technician",
				entity_id: technician.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: null, new: technician.name },
					email: { old: null, new: technician.email },
					phone: { old: null, new: technician.phone },
					title: { old: null, new: technician.title },
					status: { old: null, new: technician.status },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return technician;
		});

		return { err: "", item: created };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Error inserting technician");
		return { err: "Internal server error" };
	}
};

export const updateTechnician = async (
	id: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateTechnicianSchema.parse(data);
		// all emails in db are set to lower case
		if (parsed.email) parsed.email = parsed.email.toLowerCase();
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.technician.findFirst({ where: { id } });

		if (!existing) {
			return { err: "Technician not found" };
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
			"name",
			"email",
			"phone",
			"title",
			"description",
			"status",
			"coords",
			"hire_date",
			"last_login",
			"theme",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const technician = await tx.technician.update({
				where: { id },
				data: parsed,
				include: {
					visit_techs: {
						include: {
							visit: {
								include: {
									job: { include: { client: true } },
								},
							},
						},
					},
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "technician.updated",
					action: "updated",
					entity_type: "technician",
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

			return technician;
		});

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Error updating technician");
		return { err: "Internal server error" };
	}
};

export const checkAndClearWrappingUp = async (
	techId: string,
	organizationId: string,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const tech = await sdb.technician.findFirst({
			where: { id: techId },
			select: {
				status: true,
				organization: { select: { wrapping_up_minutes: true } },
			},
		});
		if (!tech || tech.status !== "WrappingUp") return null;

		const wrappingMinutes = tech.organization?.wrapping_up_minutes ?? 15;
		const cutoff = new Date(Date.now() - wrappingMinutes * 60 * 1000);

		// Check the tech's own most-recent clock-out rather than the visit's actual_end_at,
		// which reflects the visit level and may not match when this individual tech finished.
		const recentlyCompleted = await sdb.visit_tech_time_entry.findFirst({
			where: {
				tech_id: techId,
				clocked_out_at: { gte: cutoff },
			},
			orderBy: { clocked_out_at: "desc" },
		});

		if (!recentlyCompleted) {
			const updated = await sdb.technician.update({
				where: { id: techId },
				data: { status: "Available" },
				include: {
					visit_techs: {
						include: {
							visit: {
								include: { job: { include: { client: true } } },
							},
						},
					},
				},
			});
			return updated;
		}
		return null;
	} catch (e) {
		log.error({ err: e }, "checkAndClearWrappingUp failed");
		return null;
	}
};

// Live GPS ping: coords + last_ping_at only, no activity log (fires every ~15s while
// on shift, plus a heartbeat while stationary)
export const updateTechnicianLocation = async (
	id: string,
	data: unknown,
	organizationId: string,
) => {
	try {
		const { coords } = z.object({ coords: coordsSchema }).parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.technician.findFirst({ where: { id }, select: { id: true } });
		if (!existing) {
			return { err: "Technician not found" };
		}

		const updated = await sdb.technician.update({
			where: { id },
			data: { coords, last_ping_at: new Date() },
		});
		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Error updating technician");
		return { err: "Internal server error" };
	}
};

export const deleteTechnician = async (
	id: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.technician.findFirst({ where: { id } });

		if (!existing) {
			return { err: "Technician not found" };
		}

		const upcomingVisits = await sdb.job_visit_technician.count({
			where: {
				tech_id: id,
				visit: { status: { in: ["Scheduled", "Driving", "OnSite", "InProgress", "Paused", "Delayed"] } },
			},
		});

		if (upcomingVisits > 0) {
			return {
				err: `Can't delete this technician: they're on ${upcomingVisits} open visit${upcomingVisits === 1 ? "" : "s"}. Reassign or finish those first.`,
			};
		}

		await sdb.$transaction(async (tx) => {
			await tx.job_visit_technician.deleteMany({
				where: { tech_id: id },
			});

			await tx.technician.delete({ where: { id } });

			await logActivity({
				event_type: "technician.deleted",
				action: "deleted",
				entity_type: "technician",
				entity_id: id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: existing.name, new: null },
					email: { old: existing.email, new: null },
					status: { old: existing.status, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
		});

		return { err: "", message: "Technician deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Error deleting technician");
		return { err: "Internal server error" };
	}
};

// ── Shift lifecycle ──────────────────────────────────────────────────────────

export const startShift = async (techId: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const tech = await sdb.technician.findUnique({ where: { id: techId } });
		if (!tech) return { err: "Technician not found" };
		if (tech.status !== "Offline")
			return { err: "Technician is not Offline" };
		if (await isWeekLocked(organizationId, techId)) return { err: TIMESHEET_LOCKED };

		const updated = await sdb.$transaction(async (tx) => {
			await tx.technician_shift.create({
				data: {
					tech_id: techId,
					org_id: organizationId,
					started_at: new Date(),
				},
			});
			return tx.technician.update({
				where: { id: techId },
				data: { status: "Available" },
				include: {
					visit_techs: {
						include: {
							visit: {
								include: { job: { include: { client: true } } },
							},
						},
					},
				},
			});
		});

		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "startShift failed");
		return { err: "Internal server error" };
	}
};

// Return miles from today's last completed visit to the vehicle home (else fallback coords).
const recordReturnMiles = async (
	sdb: ReturnType<typeof getScopedDb>,
	techId: string,
	organizationId: string,
	vehicleId: string | null,
	fallback?: { lat: number; lon: number },
) => {
	const vehicle = vehicleId
		? await sdb.vehicle.findFirst({ where: { id: vehicleId }, select: { stored_at_coords: true } })
		: null;
	const returnTo = (vehicle?.stored_at_coords as { lat: number; lon: number } | null) ?? fallback;
	if (!returnTo) return;

	const org = await sdb.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } });
	const { start, end } = utcDayRange(new Date(), 1, org?.timezone ?? "UTC");
	const lastVisit = await sdb.job_visit.findFirst({
		where: {
			status: "Completed",
			actual_end_at: { not: null },
			scheduled_start_at: { gte: start, lt: end },
			visit_techs: { some: { tech_id: techId } },
		},
		include: { job: true },
		orderBy: { actual_end_at: "desc" },
	});
	if (!lastVisit || lastVisit.estimated_return_drive_miles != null) return;

	const jobCoords = lastVisit.job.coords as { lat?: number; lon?: number; lng?: number } | null;
	const jobLon = jobCoords?.lon ?? jobCoords?.lng;
	const miles = await fetchRouteDistanceMiles(
		jobCoords?.lat && jobLon ? { lat: jobCoords.lat, lon: jobLon } : null,
		returnTo,
	);
	if (miles === null) return;
	const claimed = await sdb.job_visit.updateMany({
		where: { id: lastVisit.id, estimated_return_drive_miles: null },
		data: { estimated_return_drive_miles: miles },
	});
	if (claimed.count) await applyOdometerIncrement(sdb, techId, miles);
};

export const goOffline = async (techId: string, organizationId: string, techCords?: { lat: number; lon: number }) => {
	try {
		const sdb = getScopedDb(organizationId);
		const tech = await sdb.technician.findUnique({ where: { id: techId } });
		if (!tech) return { err: "Technician not found" };

		const openEntry = await sdb.visit_tech_time_entry.findFirst({
			where: { tech_id: techId, clocked_out_at: null },
		});
		if (openEntry)
			return { err: "Cannot end shift while clocked into a visit" };

		// no-op if Head back already claimed the last visit
		await recordReturnMiles(sdb, techId, organizationId, tech.current_vehicle_id, techCords);

		// Cancel any pending WrappingUp auto-transition before status changes
		import("../services/wrappingUpTimer.js")
			.then(({ cancelWrappingUpTimer }) => {
				cancelWrappingUpTimer(techId);
			})
			.catch(() => {});

		const now = new Date();
		const updated = await sdb.$transaction(async (tx) => {
			// Close open break if any; track its unpaid hours explicitly so the
			// subsequent findMany doesn't miss it under any isolation level.
			let closedBreakUnpaidHrs = 0;
			const openBreak = await tx.technician_shift_break.findFirst({
				where: { tech_id: techId, ended_at: null },
			});
			if (openBreak) {
				const durationMs =
					now.getTime() - openBreak.started_at.getTime();
				const durationHrs = parseFloat(
					(durationMs / 3_600_000).toFixed(4),
				);
				if (!openBreak.is_paid) closedBreakUnpaidHrs = durationHrs;
				await tx.technician_shift_break.update({
					where: { id: openBreak.id },
					data: { ended_at: now, duration_hrs: durationHrs },
				});
			}

			//doesn't record the Drive time unless the tech signs out when EnRoute
			await recordDrive(tx, techId, now);

			// Close open shift
			const openShift = await tx.technician_shift.findFirst({
				where: { tech_id: techId, ended_at: null },
			});
			if (openShift) {
				const allBreaks = await tx.technician_shift_break.findMany({
					where: {
						shift_id: openShift.id,
						is_paid: false,
						ended_at: { not: null },
					},
					select: { duration_hrs: true },
				});
				// Sum previously closed breaks + the one just closed above
				const breakHours =
					allBreaks.reduce(
						(s, b) => s + Number(b.duration_hrs ?? 0),
						0,
					) + closedBreakUnpaidHrs;
				const grossMs = now.getTime() - openShift.started_at.getTime();
				const grossHours = parseFloat((grossMs / 3_600_000).toFixed(4));
				const payableHours = parseFloat(
					Math.max(0, grossHours - breakHours).toFixed(4),
				);
				await tx.technician_shift.update({
					where: { id: openShift.id },
					data: {
						ended_at: now,
						gross_hours: grossHours,
						break_hours: parseFloat(breakHours.toFixed(4)),
						payable_hours: payableHours,
					},
				});
			}

			return tx.technician.update({
				where: { id: techId },
				data: { status: "Offline" },
				include: {
					visit_techs: {
						include: {
							visit: {
								include: { job: { include: { client: true } } },
							},
						},
					},
				},
			});
		});

		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "goOffline failed");
		return { err: "Internal server error" };
	}
};

export const goOnBreak = async (
	techId: string,
	organizationId: string,
	reason: string,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const tech = await sdb.technician.findUnique({ where: { id: techId } });
		if (!tech) return { err: "Technician not found" };

		const openEntry = await sdb.visit_tech_time_entry.findFirst({
			where: { tech_id: techId, clocked_out_at: null },
		});
		if (openEntry)
			return {
				err: "Cannot take a break while clocked into a visit — use visit-level pause instead",
			};

		// Cancel WrappingUp timer if applicable
		if (tech.status === "WrappingUp") {
			import("../services/wrappingUpTimer.js")
				.then(({ cancelWrappingUpTimer }) => {
					cancelWrappingUpTimer(techId);
				})
				.catch(() => {});
		}

		const openShift = await sdb.technician_shift.findFirst({
			where: { tech_id: techId, ended_at: null },
		});
		if (!openShift)
			return { err: "No active shift found — start your shift first" };

		const validReason = toBreakReason(reason);
		if (!validReason) return { err: "Invalid break reason" };
		const isPaid = PAID_BREAK_REASONS.has(reason);
		const now = new Date();

		const updated = await sdb.$transaction(async (tx) => {
			await tx.technician_shift_break.create({
				data: {
					shift_id: openShift.id,
					tech_id: techId,
					reason: validReason,
					is_paid: isPaid,
					pre_break_status: tech.status,
					started_at: now,
				},
			});
			return tx.technician.update({
				where: { id: techId },
				data: { status: "Break" },
				include: {
					visit_techs: {
						include: {
							visit: {
								include: { job: { include: { client: true } } },
							},
						},
					},
				},
			});
		});

		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "goOnBreak failed");
		return { err: "Internal server error" };
	}
};

export const returnFromBreak = async (
	techId: string,
	organizationId: string,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const tech = await sdb.technician.findUnique({ where: { id: techId } });
		if (!tech) return { err: "Technician not found" };
		if (tech.status !== "Break")
			return { err: "Technician is not on break" };

		const openBreak = await sdb.technician_shift_break.findFirst({
			where: { tech_id: techId, ended_at: null },
		});
		if (!openBreak) return { err: "No open break record found" };

		const now = new Date();
		const durationMs = now.getTime() - openBreak.started_at.getTime();
		const durationHrs = parseFloat((durationMs / 3_600_000).toFixed(4));

		const restoreStatus = toTechnicianStatus(openBreak.pre_break_status);
		if (!restoreStatus) return { err: "Invalid break status record" };

		const updated = await sdb.$transaction(async (tx) => {
			await tx.technician_shift_break.update({
				where: { id: openBreak.id },
				data: { ended_at: now, duration_hrs: durationHrs },
			});
			return tx.technician.update({
				where: { id: techId },
				data: { status: restoreStatus },
				include: {
					visit_techs: {
						include: {
							visit: {
								include: { job: { include: { client: true } } },
							},
						},
					},
				},
			});
		});

		// If the visit completed while the tech was on break, pre_break_status was updated to
		// WrappingUp. Arm the timer now (starting from when the break ended) so the tech
		// transitions to Available after the normal wrapping-up window.
		if (restoreStatus === "WrappingUp") {
			const org = await sdb.organization.findFirst({
				where: { id: organizationId },
				select: { wrapping_up_minutes: true },
			});
			const wrappingMinutes = org?.wrapping_up_minutes ?? 15;
			import("../services/wrappingUpTimer.js")
				.then(({ scheduleWrappingUpClear }) => {
					scheduleWrappingUpClear(
						techId,
						organizationId,
						now,
						wrappingMinutes,
					);
				})
				.catch(() => {});
		}

		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "returnFromBreak failed");
		return { err: "Internal server error" };
	}
};

export const changeTechnicianPassword = async (
	id: string, 
	organization_id: string, 
	data: unknown, 
	context?: UserContext
) => {
	const parsed = changePasswordSchema.parse(data);
	const sdb = getScopedDb(organization_id);
	// password is omitted globally (db.ts); opt back in here to verify the current one.
	const technician = await sdb.technician.findFirst({
		where: { id },
		omit: { password: false },
	});

	if (!technician) {
		return { err: "Technician not found" };
	}

	const valid = await bcrypt.compare(parsed.current_password, technician.password);
	if (!valid) {
		return { err: "Current password is incorrect" };
	}
	const hashedPassword = await bcrypt.hash(parsed.new_password, 10);
	await sdb.$transaction(async (tx) => {
		await tx.technician.update({
			where: { id },
			data: {
				password: hashedPassword,
			},
		});

		await logActivity({
			event_type: "technician.password.changed",
			action: "changed",
			entity_type: "technician",
			entity_id: id,
			organization_id: organization_id,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
				? "dispatcher"
				: "system",
			actor_id: context?.techId || context?.dispatcherId,
			// Never persist hashes in the audit trail — they are readable by anyone
			// with view_technicians via the change-history endpoints.
			changes: {
				password: { old: "[hashed]", new: "[hashed]" },
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});
	});
	return { message: "Password updated successfully", err: ""};
};

export const returnFromJob = async(orgId: string, technicianId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(orgId);
		const technician = await sdb.technician.findFirst({
			where: { id: technicianId, }
		});
		if (!technician) return { err: "Technician not found"};
		const acceptedStatuses = ["WrappingUp", "Available"];
		if (!acceptedStatuses.includes(technician.status)) return { err: "Technician must be available or wrapping up to return"};
		const openShift = await sdb.technician_shift.findFirst({ where: { tech_id: technicianId, ended_at: null } });
		if (!openShift) return { err: "Technician has no open shift" };

		const result = await sdb.$transaction(async (tx) => {
			await tx.visit_tech_drive.create({
				data: {
					tech_id: technicianId,
					started_at: new Date()
				}
			});
			const result =  await tx.technician.update({
				where: { id: technicianId},
				data: {
					status: "HeadingBack"
				}
			});

			await logActivity({
				event_type: "technician.return",
				action: "return",
				entity_type: "technician",
				entity_id: technicianId,
				organization_id: orgId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
					? "dispatcher"
					: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					status: { old: technician.status, new: result.status },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			})

			return result;
		});

		// no fallback: tech is still at the job, so their coords would give ~0 miles
		await recordReturnMiles(sdb, technicianId, orgId, technician.current_vehicle_id).catch((err) =>
			log.error({ err }, "recordReturnMiles failed"),
		);

		return { item: result, err: ""};
	} catch (err) {
		log.error({ err }, "returnFromJob failed");
		return { err: "Internal server error" };
	}
}

export const markAvailable = async (technicianId: string, orgId: string, context?: UserContext) => {
	const result = await updateTechnician(technicianId, { status: "Available" }, orgId, context);
	if (!result.err) await recordDrive(getScopedDb(orgId), technicianId, new Date());
	return result;
};