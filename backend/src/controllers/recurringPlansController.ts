import { ZodError } from "zod";
import {
	Prisma,
	recurring_frequency,
	weekday,
} from "../../generated/prisma/client.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { getScopedDb } from "../lib/context.js";
import { getClosedWindows } from "../services/moduleWindowService.js";
import {
	assertInventoryItemsInOrg,
	assertDispositionVehiclesInOrg,
	plannedLineItemFields,
	templateDispositionFields,
} from "../lib/inventory.js";
import {
	createRecurringPlanSchema,
	updateRecurringPlanSchema,
	updateRecurringPlanLineItemsSchema,
	updateInvoiceScheduleSchema,
	generateOccurrencesSchema,
	skipOccurrenceSchema,
	rescheduleOccurrenceSchema,
	bulkSkipOccurrencesSchema,
	bulkRescheduleOccurrencesSchema,
} from "../lib/validate/recurringPlans.js";
import {
	LineItemToCreate,
	ChangeSet,
	OccurrenceGenerationResult,
	VisitGenerationResult,
} from "../types/common.js";
import { addDays } from "date-fns";
import {
	calculateNextInvoiceAt,
	type ScheduleFrequency,
} from "../lib/invoiceSchedule.js";
import { log } from "../services/appLogger.js";
import { generateJobNumber } from "../db.js";

// ─── Timezone-safe date helpers ───────────────────────────────────────────────
// All occurrence generation works with "YYYY-MM-DD" calendar-date strings in the
// plan's IANA timezone so that day/weekday/month checks are correct regardless of
// the server's system timezone (which is always UTC in production).

/** Convert a UTC instant to a "YYYY-MM-DD" calendar-date string in an IANA timezone. */
function toDateStr(date: Date, timezone: string): string {
	return date.toLocaleDateString("en-CA", { timeZone: timezone }); // "YYYY-MM-DD"
}

/** Return the later of two "YYYY-MM-DD" strings (lexicographic = chronological). */
function laterDate(a: string, b: string): string {
	return a > b ? a : b;
}

/** Add N calendar days to a "YYYY-MM-DD" string. */
function dateStrAddDays(dateStr: string, days: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split("T")[0];
}

/** Add N calendar months to a "YYYY-MM-DD" string (end-of-month clamped by JS Date). */
function dateStrAddMonths(dateStr: string, months: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().split("T")[0];
}

/** Add N calendar years to a "YYYY-MM-DD" string. */
function dateStrAddYears(dateStr: string, years: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(Date.UTC(y + years, m - 1, d)).toISOString().split("T")[0];
}

/**
 * Convert a local date + time in an IANA timezone to a UTC Date.
 * Uses only the Intl API — no external dependencies required.
 *
 * @param dateStr  "YYYY-MM-DD" calendar date in the given timezone
 * @param hhmm     "HH:MM" local wall-clock time
 * @param timezone IANA timezone string, e.g. "America/Chicago"
 */
function localToUTC(dateStr: string, hhmm: string, timezone: string): Date {
	// Treat the desired local time as a UTC instant (initial approximation)
	const approx = new Date(`${dateStr}T${hhmm}:00Z`);
	// Ask Intl what local clock the timezone shows for that UTC instant
	// 'sv' locale produces "YYYY-MM-DD HH:MM:SS" — easy to parse back as UTC
	const localRepr = approx.toLocaleString("sv", { timeZone: timezone });
	const localTime = new Date(localRepr.replace(" ", "T") + "Z");
	// offsetMs = local reading − UTC instant (positive for UTC+, negative for UTC−)
	const offsetMs = localTime.getTime() - approx.getTime();
	// Subtract the offset to get the UTC instant that equals the desired local time
	return new Date(approx.getTime() - offsetMs);
}

/** Parse "HH:MM" to total minutes from midnight. */
function parseHHMM(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

/** Convert total minutes from midnight to "HH:MM" (clamped to 23:59). */
function formatHHMM(totalMinutes: number): string {
	const clamped = Math.max(0, Math.min(totalMinutes, 23 * 60 + 59));
	return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

export interface UserContext {
	techId?: string;
	dispatcherId?: string;
	ipAddress?: string;
	userAgent?: string;
}

type RecurringRuleWithWeekdays = Prisma.recurring_ruleGetPayload<{
	include: { by_weekday: true };
}>;

// ============================================================================
// OCCURRENCE GENERATION LOGIC
// ============================================================================

async function generateOccurrencesForPlan(
	planId: string,
	daysAhead: number,
	tx: Prisma.TransactionClient,
): Promise<OccurrenceGenerationResult> {
	const plan = await tx.recurring_plan.findUnique({
		where: { id: planId },
		include: {
			rules: {
				include: {
					by_weekday: true,
				},
			},
		},
	});

	if (!plan) {
		throw new Error("Plan not found");
	}

	if (plan.rules.length === 0) {
		throw new Error("Plan has no rules defined");
	}

	const rule = plan.rules[0]; // Use first rule (we only support one rule per plan for now)
	const startDate = new Date();
	const endDate = addDays(startDate, daysAhead);
	const planEndDate = plan.ends_at ? new Date(plan.ends_at) : null;

	const generationEndDate =
		planEndDate && planEndDate < endDate ? planEndDate : endDate;

	const dates = calculateOccurrenceDates(
		rule,
		new Date(plan.starts_at),
		startDate,
		generationEndDate,
		plan.timezone ?? "UTC",
	);

	let generated = 0;
	let skipped = 0;

	for (const date of dates) {
		// Check if occurrence already exists
		const existing = await tx.recurring_occurrence.findFirst({
			where: {
				recurring_plan_id: planId,
				occurrence_start_at: date.start,
			},
		});

		if (existing) {
			skipped++;
			continue;
		}

		// Create occurrence — copy constraint fields from rule
		await tx.recurring_occurrence.create({
			data: {
				recurring_plan_id: planId,
				occurrence_start_at: date.start,
				occurrence_end_at: date.end,
				status: "planned",
				template_version: 1, // TODO: Implement versioning
				arrival_constraint:   rule.arrival_constraint,
				finish_constraint:    rule.finish_constraint,
				arrival_time:         rule.arrival_time,
				arrival_window_start: rule.arrival_window_start,
				arrival_window_end:   rule.arrival_window_end,
				finish_time:          rule.finish_time,
			},
		});

		generated++;
	}

	return {
		generated,
		skipped,
		start_date: startDate,
		end_date: generationEndDate,
	};
}

// Dates the rule would have produced while the org had Recurring Plans switched
// off and that were never generated. Generation never looks backwards, so these
// are gone for good; the plan page lists them so the gap is visible.
export async function getSkippedDatesForJob(jobId: string, orgId: string): Promise<Date[]> {
	const sdb = getScopedDb(orgId);
	const job = await sdb.job.findFirst({
		where: { id: jobId },
		select: { recurring_plan_id: true },
	});
	if (!job?.recurring_plan_id) return [];
	const plan = await sdb.recurring_plan.findFirst({
		where: { id: job.recurring_plan_id },
		include: { rules: { include: { by_weekday: true } } },
	});
	if (!plan || plan.rules.length === 0) return [];

	const windows = await getClosedWindows(orgId, "recurring_plans");
	const planEnd = plan.ends_at ? new Date(plan.ends_at) : null;
	const candidates: Date[] = [];
	for (const w of windows) {
		const end = planEnd && planEnd < w.on ? planEnd : w.on;
		if (end <= w.off) continue;
		for (const d of calculateOccurrenceDates(
			plan.rules[0],
			new Date(plan.starts_at),
			w.off,
			end,
			plan.timezone ?? "UTC",
		)) {
			// The rule works in whole days; keep only starts inside the window itself.
			if (d.start >= w.off && d.start <= end) candidates.push(d.start);
		}
	}
	if (candidates.length === 0) return [];
	const existing = await sdb.recurring_occurrence.findMany({
		where: { recurring_plan_id: plan.id, occurrence_start_at: { in: candidates } },
		select: { occurrence_start_at: true },
	});
	const have = new Set(existing.map((o) => o.occurrence_start_at.getTime()));
	return candidates
		.filter((d) => !have.has(d.getTime()))
		.sort((a, b) => a.getTime() - b.getTime());
}

function calculateOccurrenceDates(
	rule: RecurringRuleWithWeekdays,
	planStartDate: Date,
	rangeStart: Date,
	rangeEnd: Date,
	timezone: string,
): Array<{ start: Date; end: Date }> {
	const dates: Array<{ start: Date; end: Date }> = [];

	// Work with calendar-date strings in the plan's timezone so that day/weekday/
	// month comparisons are correct independent of the server's system timezone.
	const startDateStr = laterDate(
		toDateStr(planStartDate, timezone),
		toDateStr(rangeStart, timezone),
	);
	const endDateStr = toDateStr(rangeEnd, timezone);
	let currentDateStr = startDateStr;

	// ── Derive visit start time (HH:MM) from arrival constraint ─────────────
	let startHHMM = "09:00";
	if (rule.arrival_constraint === "at" && rule.arrival_time) {
		startHHMM = rule.arrival_time;
	} else if (rule.arrival_constraint === "between" && rule.arrival_window_start) {
		startHHMM = rule.arrival_window_start;
	} else if (rule.arrival_constraint === "by" && rule.arrival_window_end) {
		// 4 hours before deadline, floor at 9 AM
		const startM = Math.max(9 * 60, parseHHMM(rule.arrival_window_end) - 240);
		startHHMM = formatHHMM(startM);
	}

	// ── Derive duration and end time from finish constraint ──────────────────
	let durationMinutes = 120; // default 2 hours
	if (
		(rule.finish_constraint === "at" || rule.finish_constraint === "by") &&
		rule.finish_time
	) {
		durationMinutes = Math.max(0, parseHHMM(rule.finish_time) - parseHHMM(startHHMM)) || 120;
	}

	// ── Day-of-week map (JS getUTCDay: 0=Sun…6=Sat) ─────────────────────────
	const weekdayMap: Record<weekday, number> = {
		MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0,
	};

	while (currentDateStr <= endDateStr) {
		const [year, month, day] = currentDateStr.split("-").map(Number);
		// Build a UTC-midnight Date just to derive the day of week — no local time involved
		const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

		let shouldInclude = false;
		switch (rule.frequency) {
			case "daily":
				shouldInclude = true;
				break;
			case "weekly":
				shouldInclude = rule.by_weekday.some((wd) => weekdayMap[wd.weekday] === dow);
				break;
			case "monthly":
				shouldInclude = rule.by_month_day !== null && day === rule.by_month_day;
				break;
			case "yearly":
				shouldInclude =
					rule.by_month !== null &&
					rule.by_month_day !== null &&
					month === rule.by_month &&
					day === rule.by_month_day;
				break;
		}

		if (shouldInclude) {
			const occurrenceStart = localToUTC(currentDateStr, startHHMM, timezone);
			const occurrenceEnd   = addMinutes(occurrenceStart, durationMinutes);
			dates.push({ start: occurrenceStart, end: occurrenceEnd });
		}

		// Advance to the next candidate calendar date
		switch (rule.frequency) {
			case "daily":
				currentDateStr = dateStrAddDays(currentDateStr, rule.interval);
				break;
			case "weekly":
				currentDateStr = dateStrAddDays(currentDateStr, 1); // check every day, filter by weekday above
				break;
			case "monthly":
				currentDateStr = dateStrAddMonths(currentDateStr, rule.interval);
				break;
			case "yearly":
				currentDateStr = dateStrAddYears(currentDateStr, rule.interval);
				break;
		}
	}

	return dates;
}

function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * 60000);
}

// ============================================================================
// RECURRING PLAN CRUD
// ============================================================================

export const getAllRecurringPlans = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
	return await sdb.recurring_plan.findMany({
		include: {
			client: {
				select: {
					id: true,
					name: true,
					address: true,
				},
			},
			job_container: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
				},
			},
			rules: {
				include: {
					by_weekday: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			occurrences: {
				where: {
					occurrence_start_at: {
						gte: startOfToday,
					},
				},
				orderBy: { occurrence_start_at: "asc" },
				take: 5,
			},
		},
		orderBy: { created_at: "desc" },
	});
};

export const getRecurringPlanByJobId = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.recurring_plan.findFirst({
		where: {
			job_container: {
				id: jobId,
			},
		},
		include: {
			client: true,
			job_container: true,
			rules: {
				include: {
					by_weekday: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			occurrences: {
				orderBy: { occurrence_start_at: "asc" },
			},
			invoice_schedule: true,
			created_by_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
	});
};

export const getRecurringPlanById = async (planId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.recurring_plan.findUnique({
		where: { id: planId },
		include: {
			client: {
				include: {
					contacts: {
						include: {
							contact: true,
						},
					},
				},
			},
			job_container: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
					address: true,
					description: true,
					tax_rate: true,
				},
			},
			rules: {
				include: {
					by_weekday: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			occurrences: {
				orderBy: { occurrence_start_at: "asc" },
			},
			invoice_schedule: true,
			created_by_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
	});
};

export const insertRecurringPlan = async (
	req: Request,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createRecurringPlanSchema.parse(req.body);
		const sdb = getScopedDb(organizationId);
		const created = await sdb.$transaction(async (tx) => {
			const client = await tx.client.findUnique({
				where: { id: parsed.client_id },
			});

			if (!client) {
				throw new Error("Client not found");
			}

			const jobNumber = await generateJobNumber(tx, organizationId);

			// Create job container first (without recurring_plan_id)
			const job = await tx.job.create({
				data: {
					job_number: jobNumber,
					name: parsed.name,
					description: parsed.description,
					priority: parsed.priority,
					address: parsed.address,
					coords: parsed.coords,
					status: "InProgress", // Recurring job container is always in progress
					client_id: parsed.client_id,
					organization_id: client.organization_id,
				},
			});

			// Create recurring plan (without job_container reference yet)
			const plan = await tx.recurring_plan.create({
				data: {
					organization_id: client.organization_id,
					client_id: parsed.client_id,
					name: parsed.name,
					description: parsed.description,
					address: parsed.address,
					coords: parsed.coords,
					priority: parsed.priority,
					status: "Active",
					starts_at: new Date(parsed.starts_at),
					ends_at: parsed.ends_at ? new Date(parsed.ends_at) : null,
					timezone: parsed.timezone,
					generation_window_days: parsed.generation_window_days,
					min_advance_days: parsed.min_advance_days,
					billing_mode: parsed.billing_mode,
					invoice_timing: parsed.invoice_timing,
					auto_invoice: parsed.auto_invoice,
					created_by_dispatcher_id: context?.dispatcherId || null,
				},
			});

			// Link job to plan (bidirectional 1:1)
			await tx.job.update({
				where: { id: job.id },
				data: { recurring_plan_id: plan.id },
			});

			// Create recurring rule
			const rule = await tx.recurring_rule.create({
				data: {
					recurring_plan_id: plan.id,
					frequency: parsed.rule.frequency,
					interval: parsed.rule.interval,
					by_month_day: parsed.rule.by_month_day,
					by_month: parsed.rule.by_month,

					// Constraint-based scheduling
					arrival_constraint: parsed.rule.arrival_constraint,
					finish_constraint: parsed.rule.finish_constraint,
					arrival_time: parsed.rule.arrival_time,
					arrival_window_start: parsed.rule.arrival_window_start,
					arrival_window_end: parsed.rule.arrival_window_end,
					finish_time: parsed.rule.finish_time,
				},
			});

			// Create weekday relations if provided
			if (parsed.rule.by_weekday && parsed.rule.by_weekday.length > 0) {
				await tx.recurring_rule_weekday.createMany({
					data: parsed.rule.by_weekday.map((weekday) => ({
						recurring_rule_id: rule.id,
						weekday: weekday,
					})),
				});
			}

			// Create template line items
			if (parsed.line_items && parsed.line_items.length > 0) {
				await assertInventoryItemsInOrg(
					tx,
					organizationId,
					parsed.line_items.map((i) => i.inventory_item_id),
				);
				await assertDispositionVehiclesInOrg(
					tx,
					organizationId,
					parsed.line_items.map((i) => i.disposition_vehicle_id),
				);
				await tx.recurring_plan_line_item.createMany({
					data: parsed.line_items.map((item, idx) => ({
						recurring_plan_id: plan.id,
						name: item.name,
						description: item.description ?? null,
						quantity: item.quantity,
						unit_price: item.unit_price,
						item_type: item.item_type ?? null,
						sort_order: item.sort_order ?? idx,
						inventory_item_id: item.inventory_item_id ?? null,
						...templateDispositionFields(item.inventory_item_id, item),
					})),
				});
			}

			// Create invoice schedule if billing is configured
			if (parsed.invoice_schedule && parsed.billing_mode !== "none") {
				const sched = parsed.invoice_schedule;
				const nextInvoiceAt =
					sched.frequency !== "on_visit_completion"
						? calculateNextInvoiceAt(
								sched.frequency as ScheduleFrequency,
								sched.day_of_month ?? null,
								sched.day_of_week ?? null,
								sched.generate_days_before ?? 0,
							)
						: null;
				await tx.invoice_schedule.create({
					data: {
						recurring_plan_id: plan.id,
						billing_basis: sched.billing_basis,
						fixed_amount: sched.fixed_amount ?? null,
						frequency: sched.frequency,
						day_of_month: sched.day_of_month ?? null,
						day_of_week: sched.day_of_week as weekday | null ?? null,
						generate_days_before: sched.generate_days_before ?? 0,
						payment_terms_days: sched.payment_terms_days ?? 30,
						auto_send: sched.auto_send ?? false,
						memo_template: sched.memo_template ?? null,
						next_invoice_at: nextInvoiceAt,
						is_active: true,
					},
				});
			}

			// Generate initial occurrences
			await generateOccurrencesForPlan(
				plan.id,
				parsed.generation_window_days,
				tx as unknown as Prisma.TransactionClient,
			);

			// Update client activity
			await tx.client.update({
				where: { id: parsed.client_id },
				data: { last_activity: new Date() },
			});

			await logActivity({
				event_type: "recurring_plan.created",
				action: "created",
				entity_type: "recurring_plan",
				entity_id: plan.id,
				organization_id: client.organization_id,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: null, new: plan.name },
					client_id: { old: null, new: plan.client_id },
					status: { old: null, new: plan.status },
					job_id: { old: null, new: job.id },
					line_items_count: {
						old: null,
						new: parsed.line_items?.length ?? 0,
					},
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			// Return full plan with all relations
			return tx.recurring_plan.findUnique({
				where: { id: plan.id },
				include: {
					client: true,
					job_container: true,
					rules: {
						include: {
							by_weekday: true,
						},
					},
					line_items: {
						orderBy: { sort_order: "asc" },
					},
					occurrences: {
						orderBy: { occurrence_start_at: "asc" },
						take: 10,
					},
					invoice_schedule: true,
				},
			});
		});

		return { err: "", item: created ?? undefined };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		if (e instanceof Error) {
			return { err: e.message };
		}
		log.error({ err: e }, "Insert recurring plan error");
		return { err: "Internal server error" };
	}
};

export const updateRecurringPlan = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateRecurringPlanSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.recurring_plan.findFirst({
			where: {
				job_container: {
					id: jobId,
				},
			},
			include: {
				rules: {
					include: {
						by_weekday: true,
					},
				},
				line_items: true,
			},
		});

		if (!existing) {
			return { err: "Recurring plan not found" };
		}

		const changes = buildChanges(existing, parsed, [
			"name",
			"description",
			"address",
			"priority",
			"status",
			"starts_at",
			"ends_at",
			"timezone",
			"generation_window_days",
			"min_advance_days",
			"billing_mode",
			"invoice_timing",
			"auto_invoice",
			"coords",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const plan = await tx.recurring_plan.update({
				where: { id: existing.id },
				data: {
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.description !== undefined && {
						description: parsed.description,
					}),
					...(parsed.address !== undefined && {
						address: parsed.address,
					}),
					...(parsed.coords !== undefined && {
						coords: parsed.coords,
					}),
					...(parsed.priority !== undefined && {
						priority: parsed.priority,
					}),
					...(parsed.status !== undefined && {
						status: parsed.status,
					}),
					...(parsed.starts_at !== undefined && {
						starts_at: new Date(parsed.starts_at),
					}),
					...(parsed.ends_at !== undefined && {
						ends_at: parsed.ends_at
							? new Date(parsed.ends_at)
							: null,
					}),
					...(parsed.timezone !== undefined && {
						timezone: parsed.timezone,
					}),
					...(parsed.generation_window_days !== undefined && {
						generation_window_days: parsed.generation_window_days,
					}),
					...(parsed.min_advance_days !== undefined && {
						min_advance_days: parsed.min_advance_days,
					}),
					...(parsed.billing_mode !== undefined && {
						billing_mode: parsed.billing_mode,
					}),
					...(parsed.invoice_timing !== undefined && {
						invoice_timing: parsed.invoice_timing,
					}),
					...(parsed.auto_invoice !== undefined && {
						auto_invoice: parsed.auto_invoice,
					}),
				},
			});

			// Update recurring rule if provided
			if (parsed.rule && existing.rules.length > 0) {
				const existingRule = existing.rules[0];

				await tx.recurring_rule.update({
					where: { id: existingRule.id },
					data: {
						frequency: parsed.rule.frequency,
						interval: parsed.rule.interval,
						by_month_day: parsed.rule.by_month_day ?? null,
						by_month: parsed.rule.by_month ?? null,

						arrival_constraint: parsed.rule.arrival_constraint,
						finish_constraint: parsed.rule.finish_constraint,
						arrival_time: parsed.rule.arrival_time ?? null,
						arrival_window_start:
							parsed.rule.arrival_window_start ?? null,
						arrival_window_end:
							parsed.rule.arrival_window_end ?? null,
						finish_time: parsed.rule.finish_time ?? null,
					},
				});

				// Update weekdays - delete all and recreate
				await tx.recurring_rule_weekday.deleteMany({
					where: { recurring_rule_id: existingRule.id },
				});

				if (
					parsed.rule.by_weekday &&
					parsed.rule.by_weekday.length > 0
				) {
					await tx.recurring_rule_weekday.createMany({
						data: parsed.rule.by_weekday.map((weekday) => ({
							recurring_rule_id: existingRule.id,
							weekday: weekday,
						})),
					});
				}

				// Delete all future planned occurrences after schedule changed
				await tx.recurring_occurrence.deleteMany({
					where: {
						recurring_plan_id: existing.id,
						status: "planned",
						occurrence_start_at: {
							gte: new Date(),
						},
					},
				});

				// Regenerate occurrences with new schedule and generation window
				await generateOccurrencesForPlan(
					existing.id,
					plan.generation_window_days,
					tx as unknown as Prisma.TransactionClient,
				);
			}

			// Update line items if provided
			if (parsed.line_items) {
				await assertInventoryItemsInOrg(
					tx,
					organizationId,
					parsed.line_items.map((i) => i.inventory_item_id),
				);
				await assertDispositionVehiclesInOrg(
					tx,
					organizationId,
					parsed.line_items.map((i) => i.disposition_vehicle_id),
				);
				const existingItemIds = new Set(
					existing.line_items.map((item) => item.id),
				);
				const incomingItemIds = new Set(
					parsed.line_items
						.filter((item) => item.id)
						.map((item) => item.id!),
				);

				// DELETE: Items not in incoming list
				const itemsToDelete = existing.line_items.filter(
					(item) => !incomingItemIds.has(item.id),
				);

				for (const item of itemsToDelete) {
					await tx.recurring_plan_line_item.delete({
						where: { id: item.id },
					});
				}

				// CREATE OR UPDATE
				for (const item of parsed.line_items) {
					if (item.id && existingItemIds.has(item.id)) {
						await tx.recurring_plan_line_item.update({
							where: { id: item.id },
							data: {
								name: item.name,
								description: item.description || null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								item_type: item.item_type ?? null,
								sort_order: item.sort_order ?? 0,
								...(item.inventory_item_id !== undefined && {
									inventory_item_id: item.inventory_item_id,
									...templateDispositionFields(
										item.inventory_item_id,
										item,
									),
								}),
							},
						});
					} else {
						await tx.recurring_plan_line_item.create({
							data: {
								recurring_plan_id: existing.id,
								name: item.name,
								description: item.description || null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								item_type: item.item_type ?? null,
								sort_order: item.sort_order ?? 0,
								inventory_item_id: item.inventory_item_id ?? null,
								...templateDispositionFields(
									item.inventory_item_id,
									item,
								),
							},
						});
					}
				}
			}

			// Update job container if relevant fields changed
			if (
				parsed.name !== undefined ||
				parsed.description !== undefined ||
				parsed.address !== undefined ||
				parsed.coords !== undefined ||
				parsed.priority !== undefined
			) {
				await tx.job.update({
					where: { id: jobId },
					data: {
						...(parsed.name !== undefined && { name: parsed.name }),
						...(parsed.description !== undefined && {
							description: parsed.description,
						}),
						...(parsed.address !== undefined && {
							address: parsed.address,
						}),
						...(parsed.coords !== undefined && {
							coords: parsed.coords,
						}),
						...(parsed.priority !== undefined && {
							priority: parsed.priority,
						}),
					},
				});
			}

			// Upsert invoice schedule if billing configuration is provided
			if (parsed.invoice_schedule) {
				const sched = parsed.invoice_schedule;
				if (parsed.billing_mode === "none") {
					// Deactivate schedule if billing is set to none
					await tx.invoice_schedule.updateMany({
						where: { recurring_plan_id: existing.id },
						data: { is_active: false },
					});
				} else {
					// Preserve next_invoice_at when frequency/day anchor unchanged so
					// editing memo, auto_send, etc. doesn't silently reset the billing date.
					const existingSchedule = sched.frequency !== "on_visit_completion"
						? await tx.invoice_schedule.findFirst({ where: { recurring_plan_id: existing.id } })
						: null;
					const anchorChanged = !existingSchedule ||
						existingSchedule.frequency !== sched.frequency ||
						existingSchedule.day_of_month !== (sched.day_of_month ?? null) ||
						existingSchedule.day_of_week !== (sched.day_of_week ?? null) ||
						existingSchedule.generate_days_before !== (sched.generate_days_before ?? 0);
					const nextInvoiceAt =
						sched.frequency !== "on_visit_completion"
							? anchorChanged
								? calculateNextInvoiceAt(
										sched.frequency as ScheduleFrequency,
										sched.day_of_month ?? null,
										sched.day_of_week ?? null,
										sched.generate_days_before ?? 0,
									)
								: existingSchedule!.next_invoice_at
							: null;
					await tx.invoice_schedule.upsert({
						where: { recurring_plan_id: existing.id },
						create: {
							recurring_plan_id: existing.id,
							billing_basis: sched.billing_basis,
							fixed_amount: sched.fixed_amount ?? null,
							frequency: sched.frequency,
							day_of_month: sched.day_of_month ?? null,
							day_of_week: sched.day_of_week as weekday | null ?? null,
							generate_days_before: sched.generate_days_before ?? 0,
							payment_terms_days: sched.payment_terms_days ?? 30,
							auto_send: sched.auto_send ?? false,
							memo_template: sched.memo_template ?? null,
							next_invoice_at: nextInvoiceAt,
							is_active: true,
						},
						update: {
							billing_basis: sched.billing_basis,
							fixed_amount: sched.fixed_amount ?? null,
							frequency: sched.frequency,
							day_of_month: sched.day_of_month ?? null,
							day_of_week: sched.day_of_week as weekday | null ?? null,
							generate_days_before: sched.generate_days_before ?? 0,
							payment_terms_days: sched.payment_terms_days ?? 30,
							auto_send: sched.auto_send ?? false,
							memo_template: sched.memo_template ?? null,
							next_invoice_at: nextInvoiceAt,
							is_active: true,
						},
					});
				}
			}

			if (
				Object.keys(changes).length > 0 ||
				parsed.rule ||
				parsed.line_items
			) {
				await logActivity({
					event_type: "recurring_plan.updated",
					action: "updated",
					entity_type: "recurring_plan",
					entity_id: existing.id,
					organization_id: existing.organization_id,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: {
						...changes,
						...(parsed.rule && {
							rule_updated: { old: null, new: true },
						}),
						...(parsed.line_items && {
							line_items_count: {
								old: existing.line_items.length,
								new: parsed.line_items.length,
							},
						}),
					},
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			// Return full plan with all relations
			return tx.recurring_plan.findUnique({
				where: { id: existing.id },
				include: {
					client: {
						include: {
							contacts: {
								include: {
									contact: true,
								},
							},
						},
					},
					job_container: {
						select: {
							id: true,
							job_number: true,
							name: true,
							status: true,
							address: true,
							description: true,
							tax_rate: true,
						},
					},
					rules: {
						include: {
							by_weekday: true,
						},
					},
					line_items: {
						orderBy: { sort_order: "asc" },
					},
					occurrences: {
						orderBy: { occurrence_start_at: "asc" },
					},
					invoice_schedule: true,
					created_by_dispatcher: {
						select: {
							id: true,
							name: true,
							email: true,
						},
					},
				},
			});
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
		// Without this the org guards surface as an opaque internal error.
		if (e instanceof Error && e.message.startsWith("Validation failed:")) {
			return { err: e.message };
		}
		log.error({ err: e }, "Update recurring plan error");
		return { err: "Internal server error" };
	}
};

export const updateRecurringPlanLineItems = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateRecurringPlanLineItemsSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const plan = await sdb.recurring_plan.findFirst({
			where: {
				job_container: {
					id: jobId,
				},
			},
			include: {
				line_items: true,
			},
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		const updated = await sdb.$transaction(async (tx) => {
			await assertInventoryItemsInOrg(
				tx,
				organizationId,
				parsed.line_items.map((i) => i.inventory_item_id),
			);
			await assertDispositionVehiclesInOrg(
				tx,
				organizationId,
				parsed.line_items.map((i) => i.disposition_vehicle_id),
			);
			const existingItemIds = new Set(
				plan.line_items.map((item) => item.id),
			);
			const incomingItemIds = new Set(
				parsed.line_items
					.filter((item) => item.id)
					.map((item) => item.id!),
			);

			// DELETE: Items not in incoming list
			const itemsToDelete = plan.line_items.filter(
				(item) => !incomingItemIds.has(item.id),
			);

			for (const item of itemsToDelete) {
				await tx.recurring_plan_line_item.delete({
					where: { id: item.id },
				});
			}

			// CREATE OR UPDATE
			for (const item of parsed.line_items) {
				if (item.id && existingItemIds.has(item.id)) {
					await tx.recurring_plan_line_item.update({
						where: { id: item.id },
						data: {
							name: item.name,
							description: item.description || null,
							quantity: item.quantity,
							unit_price: item.unit_price,
							item_type: item.item_type ?? null,
							sort_order: item.sort_order ?? 0,
							...(item.inventory_item_id !== undefined && {
								inventory_item_id: item.inventory_item_id,
								...templateDispositionFields(item.inventory_item_id, item),
							}),
						},
					});
				} else {
					await tx.recurring_plan_line_item.create({
						data: {
							recurring_plan_id: plan.id,
							name: item.name,
							description: item.description || null,
							quantity: item.quantity,
							unit_price: item.unit_price,
							item_type: item.item_type ?? null,
							sort_order: item.sort_order ?? 0,
							inventory_item_id: item.inventory_item_id ?? null,
							...templateDispositionFields(item.inventory_item_id, item),
						},
					});
				}
			}

			await logActivity({
				event_type: "recurring_plan.template_updated",
				action: "updated",
				entity_type: "recurring_plan",
				entity_id: plan.id,
				organization_id: plan.organization_id,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					line_items_count: {
						old: plan.line_items.length,
						new: parsed.line_items.length,
					},
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return tx.recurring_plan.findUnique({
				where: { id: plan.id },
				include: {
					line_items: {
						orderBy: { sort_order: "asc" },
					},
				},
			});
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
		// Without this the org guards surface as an opaque internal error.
		if (e instanceof Error && e.message.startsWith("Validation failed:")) {
			return { err: e.message };
		}
		log.error({ err: e }, "Update recurring plan line items error");
		return { err: "Internal server error" };
	}
};

// ============================================================================
// INVOICE SCHEDULE
// ============================================================================

export const upsertInvoiceSchedule = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateInvoiceScheduleSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const plan = await sdb.recurring_plan.findFirst({
			where: { job_container: { id: jobId } },
		});

		if (!plan) return { err: "Recurring plan not found" };

		// Preserve next_invoice_at when frequency/day anchor unchanged
		const existingSchedule = parsed.frequency !== "on_visit_completion"
			? await sdb.invoice_schedule.findFirst({ where: { recurring_plan_id: plan.id } })
			: null;
		const anchorChanged = !existingSchedule ||
			existingSchedule.frequency !== parsed.frequency ||
			existingSchedule.day_of_month !== (parsed.day_of_month ?? null) ||
			existingSchedule.day_of_week !== (parsed.day_of_week ?? null) ||
			existingSchedule.generate_days_before !== (parsed.generate_days_before ?? 0);
		const nextInvoiceAt =
			parsed.frequency !== "on_visit_completion"
				? anchorChanged
					? calculateNextInvoiceAt(
							parsed.frequency as ScheduleFrequency,
							parsed.day_of_month ?? null,
							parsed.day_of_week ?? null,
							parsed.generate_days_before ?? 0,
						)
					: existingSchedule!.next_invoice_at
				: null;

		const schedule = await sdb.invoice_schedule.upsert({
			where: { recurring_plan_id: plan.id },
			create: {
				recurring_plan_id: plan.id,
				billing_basis: parsed.billing_basis,
				fixed_amount: parsed.fixed_amount ?? null,
				frequency: parsed.frequency,
				day_of_month: parsed.day_of_month ?? null,
				day_of_week: parsed.day_of_week as weekday | null ?? null,
				generate_days_before: parsed.generate_days_before ?? 0,
				payment_terms_days: parsed.payment_terms_days ?? 30,
				auto_send: parsed.auto_send ?? false,
				memo_template: parsed.memo_template ?? null,
				next_invoice_at: nextInvoiceAt,
				is_active: true,
			},
			update: {
				billing_basis: parsed.billing_basis,
				fixed_amount: parsed.fixed_amount ?? null,
				frequency: parsed.frequency,
				day_of_month: parsed.day_of_month ?? null,
				day_of_week: parsed.day_of_week as weekday | null ?? null,
				generate_days_before: parsed.generate_days_before ?? 0,
				payment_terms_days: parsed.payment_terms_days ?? 30,
				auto_send: parsed.auto_send ?? false,
				memo_template: parsed.memo_template ?? null,
				next_invoice_at: nextInvoiceAt,
				is_active: true,
			},
		});

		return { err: "", item: schedule };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Upsert invoice schedule error");
		return { err: "Internal server error" };
	}
};

export const deleteInvoiceSchedule = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const plan = await sdb.recurring_plan.findFirst({
		where: { job_container: { id: jobId } },
	});

	if (!plan) return { err: "Recurring plan not found" };

	await sdb.invoice_schedule.deleteMany({
		where: { recurring_plan_id: plan.id },
	});

	return { err: "" };
};

// ============================================================================
// PLAN LIFECYCLE ACTIONS
// ============================================================================

export const pauseRecurringPlan = async (
	jobId: string,
	organizationId: string,
	context?: UserContext,
) => {
	return updateRecurringPlan(jobId, { status: "Paused" }, organizationId, context);
};

export const resumeRecurringPlan = async (
	jobId: string,
	organizationId: string,
	context?: UserContext,
) => {
	return updateRecurringPlan(jobId, { status: "Active" }, organizationId, context);
};

export const cancelRecurringPlan = async (
	jobId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const plan = await sdb.recurring_plan.findFirst({
			where: {
				job_container: {
					id: jobId,
				},
			},
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		const updated = await sdb.$transaction(async (tx) => {
			// Cancel all future planned occurrences
			await tx.recurring_occurrence.updateMany({
				where: {
					recurring_plan_id: plan.id,
					status: "planned",
					occurrence_start_at: {
						gt: new Date(),
					},
				},
				data: {
					status: "cancelled",
					skip_reason: "Plan cancelled",
				},
			});

			// Update plan status
			const updatedPlan = await tx.recurring_plan.update({
				where: { id: plan.id },
				data: { status: "Cancelled" },
			});

			await logActivity({
				event_type: "recurring_plan.cancelled",
				action: "updated",
				entity_type: "recurring_plan",
				entity_id: plan.id,
				organization_id: plan.organization_id,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					status: { old: plan.status, new: "Cancelled" },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return updatedPlan;
		});

		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "Cancel recurring plan error");
		return { err: "Internal server error" };
	}
};

export const completeRecurringPlan = async (
	jobId: string,
	organizationId: string,
	context?: UserContext,
) => {
	return updateRecurringPlan(jobId, { status: "Completed" }, organizationId, context);
};

// ============================================================================
// OCCURRENCE MANAGEMENT
// ============================================================================

export const getOccurrencesByJobId = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const plan = await sdb.recurring_plan.findFirst({
		where: {
			job_container: {
				id: jobId,
			},
		},
	});

	if (!plan) {
		return [];
	}

	return await sdb.recurring_occurrence.findMany({
		where: { recurring_plan_id: plan.id },
		include: {
			job_visit: {
				include: {
					visit_techs: {
						include: {
							tech: true,
						},
					},
				},
			},
		},
		orderBy: { occurrence_start_at: "asc" },
	});
};

export const generateOccurrences = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = generateOccurrencesSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const plan = await sdb.recurring_plan.findFirst({
			where: {
				job_container: {
					id: jobId,
				},
			},
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		if (plan.status !== "Active") {
			return { err: "Can only generate occurrences for active plans" };
		}

		const result = await sdb.$transaction(async (tx) => {
			return await generateOccurrencesForPlan(
				plan.id,
				parsed.days_ahead,
				tx as unknown as Prisma.TransactionClient,
			);
		});

		await logActivity({
			event_type: "recurring_occurrence.generated",
			action: "created",
			entity_type: "recurring_plan",
			entity_id: plan.id,
			organization_id: plan.organization_id,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				generated_count: { old: null, new: result.generated },
				days_ahead: { old: null, new: parsed.days_ahead },
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: result };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		if (e instanceof Error) {
			return { err: e.message };
		}
		log.error({ err: e }, "Generate occurrences error");
		return { err: "Internal server error" };
	}
};

export const skipOccurrence = async (
	occurrenceId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = skipOccurrenceSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const occurrence = await sdb.recurring_occurrence.findUnique({
			where: { id: occurrenceId },
		});

		if (!occurrence) {
			return { err: "Occurrence not found" };
		}

		if (occurrence.status !== "planned") {
			return { err: "Can only skip planned occurrences" };
		}

		const updated = await sdb.recurring_occurrence.update({
			where: { id: occurrenceId },
			data: {
				status: "skipped",
				skip_reason: parsed.skip_reason,
				skipped_at: new Date(),
			},
		});

		await logActivity({
			event_type: "recurring_occurrence.skipped",
			action: "updated",
			entity_type: "recurring_occurrence",
			entity_id: occurrenceId,
			organization_id: organizationId,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				status: { old: "planned", new: "skipped" },
				skip_reason: { old: null, new: parsed.skip_reason },
				...parentBreadcrumb("recurring_plan", occurrence.recurring_plan_id),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
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
		log.error({ err: e }, "Skip occurrence error");
		return { err: "Internal server error" };
	}
};

export const rescheduleOccurrence = async (
	occurrenceId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = rescheduleOccurrenceSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const occurrence = await sdb.recurring_occurrence.findUnique({
			where: { id: occurrenceId },
		});

		if (!occurrence) {
			return { err: "Occurrence not found" };
		}

		if (occurrence.status !== "planned") {
			return { err: "Can only reschedule planned occurrences" };
		}

		const newStartDate = new Date(parsed.new_start_at);
		const newEndDate = parsed.new_end_at
			? new Date(parsed.new_end_at)
			: occurrence.occurrence_end_at;

		// Build optional constraint update data
		const constraintData = {
			...(parsed.arrival_constraint   !== undefined && { arrival_constraint:   parsed.arrival_constraint }),
			...(parsed.finish_constraint    !== undefined && { finish_constraint:    parsed.finish_constraint }),
			...(parsed.arrival_time         !== undefined && { arrival_time:         parsed.arrival_time }),
			...(parsed.arrival_window_start !== undefined && { arrival_window_start: parsed.arrival_window_start }),
			...(parsed.arrival_window_end   !== undefined && { arrival_window_end:   parsed.arrival_window_end }),
			...(parsed.finish_time          !== undefined && { finish_time:          parsed.finish_time }),
		};

		const updated = await sdb.recurring_occurrence.update({
			where: { id: occurrenceId },
			data: {
				occurrence_start_at: newStartDate,
				occurrence_end_at: newEndDate,
				...constraintData,
			},
		});

		// ── "This & all future" — shift future planned occurrences by the same delta ──
		if (parsed.scope === "future") {
			const deltaMs = newStartDate.getTime() - occurrence.occurrence_start_at.getTime();
			const futureOccurrences = await sdb.recurring_occurrence.findMany({
				where: {
					recurring_plan_id: occurrence.recurring_plan_id,
					occurrence_start_at: { gt: occurrence.occurrence_start_at },
					status: "planned",
					id: { not: occurrenceId },
				},
				select: { id: true, occurrence_start_at: true, occurrence_end_at: true },
			});
			if (futureOccurrences.length > 0) {
				await sdb.$transaction(
					futureOccurrences.map((o) =>
						sdb.recurring_occurrence.update({
							where: { id: o.id },
							data: {
								occurrence_start_at: new Date(o.occurrence_start_at.getTime() + deltaMs),
								occurrence_end_at: new Date(o.occurrence_end_at.getTime() + deltaMs),
								...constraintData,
							},
						}),
					),
				);
			}

			// Update the rule so newly generated occurrences also inherit the constraint change
			if (Object.keys(constraintData).length > 0) {
				await sdb.recurring_rule.updateMany({
					where: { recurring_plan_id: occurrence.recurring_plan_id },
					data: constraintData,
				});
			}
		}

		await logActivity({
			event_type: "recurring_occurrence.rescheduled",
			action: "updated",
			entity_type: "recurring_occurrence",
			entity_id: occurrenceId,
			organization_id: organizationId,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				occurrence_start_at: {
					old: occurrence.occurrence_start_at,
					new: newStartDate,
				},
				occurrence_end_at: {
					old: occurrence.occurrence_end_at,
					new: newEndDate,
				},
				...parentBreadcrumb("recurring_plan", occurrence.recurring_plan_id),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			log.error({ err: e }, "Reschedule occurrence validation error");
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}

		if (e instanceof Error && "code" in e && (e as any).code === "P2002") {
			log.error({ err: e }, "Unique constraint violation");
			return {
				err: "Cannot reschedule: An occurrence from this recurring plan already exists at this date and time.",
			};
		}

		log.error({ err: e }, "Reschedule occurrence error");
		if (e instanceof Error) {
			return { err: e.message };
		}
		return { err: "Internal server error" };
	}
};

export const bulkSkipOccurrences = async (
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = bulkSkipOccurrencesSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const { result, representativePlanId } = await sdb.$transaction(async (tx) => {
			const representative = await tx.recurring_occurrence.findUnique({
				where: { id: parsed.occurrence_ids[0] },
				select: { recurring_plan_id: true },
			});

			const updated = await tx.recurring_occurrence.updateMany({
				where: {
					id: { in: parsed.occurrence_ids },
					status: "planned",
				},
				data: {
					status: "skipped",
					skip_reason: parsed.skip_reason,
					skipped_at: new Date(),
				},
			});

			return { result: updated, representativePlanId: representative?.recurring_plan_id ?? null };
		});

		await logActivity({
			event_type: "recurring_occurrence.bulk_skipped",
			action: "updated",
			entity_type: "recurring_occurrence",
			entity_id: parsed.occurrence_ids[0],
			organization_id: organizationId,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				count: { old: null, new: result.count },
				skip_reason: { old: null, new: parsed.skip_reason },
				...(representativePlanId ? parentBreadcrumb("recurring_plan", representativePlanId) : {}),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: { skipped: result.count } };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Bulk skip occurrences error");
		return { err: "Internal server error" };
	}
};

// ============================================================================
// VISIT GENERATION
// ============================================================================

export const generateVisitFromOccurrence = async (
	occurrenceId: string,
	organizationId: string,
	context?: UserContext,
): Promise<{ err: string; item?: VisitGenerationResult }> => {
	try {
		const sdb = getScopedDb(organizationId);
		const occurrence = await sdb.recurring_occurrence.findUnique({
			where: { id: occurrenceId },
			include: {
				recurring_plan: {
					include: {
						line_items: {
							orderBy: { sort_order: "asc" },
						},
						job_container: true,
						rules: {
							include: {
								by_weekday: true,
							},
						},
					},
				},
			},
		});

		if (!occurrence) {
			return { err: "Occurrence not found" };
		}

		if (occurrence.status !== "planned") {
			return { err: "Occurrence must be in planned state" };
		}

		if (occurrence.job_visit_id) {
			return { err: "Visit already generated for this occurrence" };
		}

		const plan = occurrence.recurring_plan;
		const rule = plan.rules[0];

		const result = await sdb.$transaction(async (tx) => {
			// Calculate subtotal from template line items
			const subtotal = plan.line_items.reduce(
				(sum, item) =>
					sum + Number(item.quantity) * Number(item.unit_price),
				0,
			);

			const visit = await tx.job_visit.create({
				data: {
					job_id: plan.job_container!.id,
					scheduled_start_at: occurrence.occurrence_start_at,
					scheduled_end_at: occurrence.occurrence_end_at,

					arrival_constraint: occurrence.arrival_constraint,
					finish_constraint: occurrence.finish_constraint,
					arrival_time: occurrence.arrival_time,
					arrival_window_start: occurrence.arrival_window_start,
					arrival_window_end: occurrence.arrival_window_end,
					finish_time: occurrence.finish_time,

					status: "Scheduled",
					subtotal: subtotal,
					tax_rate: plan.job_container!.tax_rate || 0,

					// Copy template line items
					line_items: {
						createMany: {
							data: plan.line_items.map((item, idx) => ({
								name: item.name,
								description: item.description,
								quantity: Number(item.quantity),
								unit_price: Number(item.unit_price),
								total:
									Number(item.quantity) *
									Number(item.unit_price),
								source: "recurring_plan",
								item_type: item.item_type,
								sort_order: idx,
								// A generated visit's parts are planned parts —
								// same lifecycle a dispatcher gets when they
								// attach an item by hand, so readiness and the
								// completion deduction see them identically.
								// Intent rides along with the link: a plan
								// whose part is vendor-direct generates
								// vendor-direct visit lines, not warehouse
								// deductions.
								...plannedLineItemFields(
									item.inventory_item_id,
									Number(item.quantity),
									item,
								),
							})),
						},
					},
				},
			});

			await tx.recurring_occurrence.update({
				where: { id: occurrenceId },
				data: {
					status: "generated",
					job_visit_id: visit.id,
					generated_at: new Date(),
				},
			});

			await logActivity({
				event_type: "job_visit.generated_from_occurrence",
				action: "created",
				entity_type: "job_visit",
				entity_id: visit.id,
				organization_id: plan.organization_id,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					occurrence_id: { old: null, new: occurrenceId },
					scheduled_start_at: {
						old: null,
						new: visit.scheduled_start_at,
					},
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return {
				visit_id: visit.id,
				occurrence_id: occurrenceId,
				scheduled_start_at: visit.scheduled_start_at,
				scheduled_end_at: visit.scheduled_end_at,
				template_version: occurrence.template_version,
			};
		});

		return { err: "", item: result };
	} catch (e) {
		if (e instanceof Error) {
			return { err: e.message };
		}
		log.error({ err: e }, "Generate visit from occurrence error");
		return { err: "Internal server error" };
	}
};
