/**
 * Arrival tracking reads: `get_arrival_status` and `get_on_time_performance`.
 *
 * The forecasts are written every minute by services/arrivalTracker from Mapbox
 * live traffic; these tools only read them, through the same projection the
 * dispatch board uses, so the assistant never disagrees with the screen.
 */

import { z } from "zod";
import { defineTool } from "../registry.js";
import { listArrivals, onTimePerformance } from "../../lib/arrivals.js";

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
	.describe("Date in YYYY-MM-DD.");

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const getArrivalStatus = defineTool({
	name: "get_arrival_status",
	title: "Get arrival status",
	description:
		"Live on-time forecast for technicians heading to visits, from Mapbox live traffic, refreshed every minute. " +
		"Each row is one technician on one visit: status (late, at_risk, on_time, unknown, arrived), the time they're " +
		"due, their ETA, minutes late (negative = minutes to spare), when they must leave by, drive time, and how much " +
		"traffic is adding. Without filters it returns the board: visits due from 4 hours ago to 3 hours ahead plus " +
		"arrivals in the last hour, worst first. Use this for 'is anyone running late', 'will Sam make the 2pm', or " +
		"'when will the tech get to the Miller job'. stop_index > 0 means the ETA assumes they finish earlier visits " +
		"on schedule. stale = true means the forecast hasn't refreshed recently and shouldn't be relied on.",
	risk: "read",
	permissions: ["view_jobs", "view_visits", "view_all_jobs", "view_team_schedule"],
	input: z.object({
		visit_id: z.string().uuid().optional().describe("Every technician's forecast for this visit, at any time."),
		technician_id: z.string().uuid().optional().describe("Only this technician."),
	}),
	async handler({ input, db }) {
		const { as_of, summary, arrivals } = await listArrivals(db, {
			visitId: input.visit_id,
			techId: input.technician_id,
		});
		return {
			as_of: as_of.toISOString(),
			summary,
			arrivals: arrivals.map((a) => ({
				visit_id: a.visit_id,
				visit: a.visit_name,
				job_id: a.job_id,
				job_number: a.job_number,
				client: a.client_name,
				address: a.address,
				technician_id: a.tech_id,
				technician: a.tech_name,
				status: a.status,
				basis: a.basis,
				en_route: a.en_route,
				stop_index: a.stop_index,
				due_at: iso(a.due_at),
				eta_at: iso(a.eta_at),
				leave_by_at: iso(a.leave_by_at),
				arrived_at: iso(a.arrived_at),
				minutes_late: a.delay_minutes,
				drive_minutes: a.drive_minutes,
				traffic_delay_minutes: a.traffic_delay_minutes,
				distance_miles: a.distance_miles,
				dispatch_alerted: a.alerted,
				updated_at: iso(a.computed_at),
				stale: a.stale,
			})),
		};
	},
});

export const getOnTimePerformance = defineTool({
	name: "get_on_time_performance",
	title: "Get on-time performance",
	description:
		"How often technicians actually arrived on time over a date range, overall and per technician, measured " +
		"against each visit's promised arrival time (or scheduled start for 'anytime' visits) with a 5-minute grace. " +
		"Use this for 'who's been late this week' or 'what's our on-time rate'. Only arrivals tracked live are counted.",
	risk: "read",
	permissions: ["view_jobs", "view_reports", "view_technicians"],
	input: z.object({
		start_date: isoDate.describe("First day of the range, inclusive."),
		end_date: isoDate.describe("Last day of the range, inclusive."),
		technician_id: z.string().uuid().optional().describe("Limit to one technician."),
	}),
	async handler({ input, db }) {
		// UTC days, matching get_schedule
		const start = new Date(`${input.start_date}T00:00:00.000Z`);
		const end = new Date(new Date(`${input.end_date}T00:00:00.000Z`).getTime() + 24 * 3600_000);
		if (start >= end) return { error: "start_date is after end_date" };
		return {
			range: { start: input.start_date, end: input.end_date, timezone: "UTC" },
			...(await onTimePerformance(db, { start, end }, input.technician_id)),
		};
	},
});
