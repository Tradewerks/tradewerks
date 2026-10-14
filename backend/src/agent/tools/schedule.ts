/**
 * Scheduling reads: `get_schedule` and `get_technician_availability`.
 *
 * These are separate tools rather than filters on `list_records` because they
 * answer different questions and want different shapes. `list_records(visit)`
 * returns a flat list; a dispatcher asking "what does Thursday look like" wants
 * it grouped by day with the unassigned work called out, because unassigned
 * work is the thing they are actually looking for.
 */

import { z } from "zod";
import { defineTool } from "../registry.js";

/** Whole days in UTC. Org-local day boundaries are a Phase 2 refinement — see the note in handler(). */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
	.describe("Date in YYYY-MM-DD.");

export const getSchedule = defineTool({
	name: "get_schedule",
	title: "Get schedule",
	description:
		"The visit schedule over a date range, grouped by day, with each visit's window, status, client, address, and " +
		"assigned technicians. Unassigned visits are listed separately — that is usually what a scheduling question is " +
		"really about. Use this for 'what does Tuesday look like', 'who is on the Miller job', or 'what still needs a tech'.",
	risk: "read",
	permissions: ["view_jobs", "view_visits", "view_all_jobs", "view_assigned_jobs", "view_own_schedule", "view_team_schedule"],
	input: z.object({
		start_date: isoDate.describe("First day of the range, inclusive."),
		end_date: isoDate.describe("Last day of the range, inclusive."),
		technician_id: z.string().uuid().optional().describe("Only visits this technician is assigned to."),
		include_cancelled: z.boolean().default(false).describe("Include cancelled visits. Off by default."),
	}),
	async handler({ input, db }) {
		const start = new Date(`${input.start_date}T00:00:00.000Z`);
		// end_date is inclusive, so the window runs to the last millisecond of that day.
		const end = new Date(`${input.end_date}T23:59:59.999Z`);
		if (start > end) {
			return { error: "start_date is after end_date", days: [], unassigned: [] };
		}

		// NOTE: the window is UTC. Orgs carry an IANA timezone
		// (organization.timezone, surfaced in the JWT as organization_timezone),
		// so a late-evening visit can land on the neighbouring day for orgs far
		// from UTC. Correct fix is to build the window in the org's zone; doing it
		// here would silently disagree with the rest of the read layer, so it is
		// deferred to the Phase 2 pass that does the same for reports.
		const visits = await db.job_visit.findMany({
			where: {
				scheduled_start_at: { gte: start, lte: end },
				...(input.include_cancelled ? {} : { status: { not: "Cancelled" } }),
				...(input.technician_id ? { visit_techs: { some: { tech_id: input.technician_id } } } : {}),
			},
			select: {
				id: true,
				name: true,
				status: true,
				scheduled_start_at: true,
				scheduled_end_at: true,
				arrival_constraint: true,
				job: {
					select: {
						id: true,
						job_number: true,
						name: true,
						address: true,
						priority: true,
						client: { select: { id: true, name: true } },
					},
				},
				visit_techs: { select: { tech_status: true, tech: { select: { id: true, name: true } } } },
			},
			orderBy: { scheduled_start_at: "asc" },
			// A month of a busy org's visits still has to fit a context window.
			take: 400,
		});

		const shaped = visits.map((v) => ({
			id: v.id,
			name: v.name ?? v.job.name,
			status: v.status,
			starts_at: v.scheduled_start_at.toISOString(),
			ends_at: v.scheduled_end_at.toISOString(),
			arrival: v.arrival_constraint,
			job_id: v.job.id,
			job_number: v.job.job_number,
			priority: v.job.priority,
			client: v.job.client?.name,
			address: v.job.address,
			technicians: v.visit_techs.map((t) => ({ id: t.tech.id, name: t.tech.name, status: t.tech_status })),
		}));

		const byDay = new Map<string, typeof shaped>();
		for (const visit of shaped) {
			const key = dayKey(new Date(visit.starts_at));
			const bucket = byDay.get(key);
			if (bucket) bucket.push(visit);
			else byDay.set(key, [visit]);
		}

		return {
			range: { start: input.start_date, end: input.end_date, timezone: "UTC" },
			total_visits: shaped.length,
			truncated: visits.length === 400,
			days: [...byDay.entries()].map(([date, dayVisits]) => ({
				date,
				count: dayVisits.length,
				visits: dayVisits,
			})),
			unassigned: shaped.filter((v) => v.technicians.length === 0),
		};
	},
});

export const getTechnicianAvailability = defineTool({
	name: "get_technician_availability",
	title: "Get technician availability",
	description:
		"Each technician's current status, whether they are clocked in, and what they are already booked on over a " +
		"date range. Use this before assigning or rescheduling work — it is how you tell who is actually free.",
	risk: "read",
	permissions: ["view_technicians", "view_team_schedule"],
	input: z.object({
		start_date: isoDate.describe("First day of the window, inclusive."),
		end_date: isoDate.describe("Last day of the window, inclusive."),
		technician_id: z.string().uuid().optional().describe("Limit to one technician."),
	}),
	async handler({ input, db }) {
		const start = new Date(`${input.start_date}T00:00:00.000Z`);
		const end = new Date(`${input.end_date}T23:59:59.999Z`);

		// Shifts are read through the technician relation on purpose. technician_shift
		// keys its tenant column `org_id` rather than `organization_id` and is not
		// registered in lib/context.ts, so getScopedDb does NOT filter it directly —
		// reaching it via the (scoped) technician keeps tenancy intact without
		// relying on a filter someone has to remember to write.
		const techs = await db.technician.findMany({
			where: input.technician_id ? { id: input.technician_id, deactivated_at: null } : { deactivated_at: null },
			select: {
				id: true,
				name: true,
				title: true,
				status: true,
				current_vehicle: { select: { id: true, name: true } },
				shifts: {
					where: { ended_at: null },
					select: { id: true, started_at: true },
					orderBy: { started_at: "desc" },
					take: 1,
				},
				visit_techs: {
					where: {
						visit: {
							scheduled_start_at: { gte: start, lte: end },
							status: { not: "Cancelled" },
						},
					},
					select: {
						tech_status: true,
						visit: {
							select: {
								id: true,
								status: true,
								scheduled_start_at: true,
								scheduled_end_at: true,
								job: { select: { job_number: true, address: true, client: { select: { name: true } } } },
							},
						},
					},
				},
			},
			orderBy: { name: "asc" },
			take: 200,
		});

		return {
			range: { start: input.start_date, end: input.end_date, timezone: "UTC" },
			technicians: techs.map((t) => {
				const booked = t.visit_techs
					.map((vt) => ({
						visit_id: vt.visit.id,
						status: vt.visit.status,
						assignment_status: vt.tech_status,
						starts_at: vt.visit.scheduled_start_at.toISOString(),
						ends_at: vt.visit.scheduled_end_at.toISOString(),
						job_number: vt.visit.job.job_number,
						client: vt.visit.job.client?.name,
						address: vt.visit.job.address,
					}))
					.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

				return {
					id: t.id,
					name: t.name,
					title: t.title,
					status: t.status,
					vehicle: t.current_vehicle?.name,
					on_shift: t.shifts.length > 0,
					shift_started_at: t.shifts[0]?.started_at.toISOString(),
					booked_visits: booked.length,
					bookings: booked,
				};
			}),
		};
	},
});
