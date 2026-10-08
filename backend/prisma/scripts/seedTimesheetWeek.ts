/**
 * Adds a past week's (Mon–Fri) shifts, breaks, drives and visit time entries for up to 3 techs.
 * Days vary (paid breaks, back-to-back visits, visits clipped by the shift, half days, days off).
 * Skips any tech-day that already has a shift, so re-runs are safe.
 *
 *   npx tsx prisma/scripts/seedTimesheetWeek.ts [--org=<organization id>] [--weeksAgo=1]
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const orgArg = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length);

const weeksAgo = Number(process.argv.find((a) => a.startsWith("--weeksAgo="))?.slice("--weeksAgo=".length) ?? 1);

type Plan = {
	start: number;
	end: number;
	breaks: { from: number; to: number; reason: "Lunch" | "Rest"; paid: boolean }[];
	visits: number[][];
};
const LUNCH = { from: 12, to: 12.5, reason: "Lunch" as const, paid: false };

// null = day off
const DAY_PLANS: (Plan | null)[] = [
	{ start: 7, end: 16, breaks: [LUNCH], visits: [[7.5, 10.25], [10.75, 12], [12.5, 15.5]] },
	// paid break in the middle of a visit
	{ start: 8, end: 16.5, breaks: [{ from: 10, to: 10.25, reason: "Rest", paid: true }, LUNCH], visits: [[8.5, 11.5], [13, 15]] },
	// mostly unassigned
	{ start: 7.5, end: 15.5, breaks: [LUNCH], visits: [[8, 9.5]] },
	// visit starts before the shift, back-to-back visits, visit runs over lunch, long day
	{ start: 6.5, end: 17.75, breaks: [{ from: 12.25, to: 12.75, reason: "Lunch", paid: false }], visits: [[6, 7.5], [8, 9], [9, 10], [11.5, 13], [14, 17.5]] },
	// half day, no breaks
	{ start: 9, end: 13, breaks: [], visits: [[9.25, 12.75]] },
	null,
	// overnight, hours past 24 are the next day
	{ start: 20, end: 28.5, breaks: [{ from: 24, to: 24.5, reason: "Lunch", paid: false }], visits: [[20.5, 23], [23.5, 26], [26.5, 28]] },
	// early start
	{ start: 4.5, end: 13, breaks: [{ from: 9, to: 9.5, reason: "Lunch", paid: false }], visits: [[5, 8], [8.5, 12.5]] },
	// late finish, same day
	{ start: 11, end: 22.5, breaks: [{ from: 17, to: 17.5, reason: "Lunch", paid: false }], visits: [[11.5, 14], [15, 17], [18, 22]] },
];

function atLocal(dateStr: string, h: number, tz: string): Date {
	const anchor = new Date(Date.parse(`${dateStr}T00:00:00Z`) + h * 3_600_000);
	const local = new Date(anchor.toLocaleString("en-US", { timeZone: tz, hourCycle: "h23" }));
	const utcAsLocal = new Date(anchor.toLocaleString("en-US", { timeZone: "UTC", hourCycle: "h23" }));
	return new Date(anchor.getTime() + (utcAsLocal.getTime() - local.getTime()));
}

async function main() {
	const org = await db.organization.findFirst({
		where: orgArg ? { id: orgArg } : { technicians: { some: {} } },
		select: { id: true, name: true, timezone: true },
	});
	if (!org) throw new Error("No organization with technicians found");
	const tz = org.timezone ?? "UTC";

	const techs = await db.technician.findMany({
		where: { organization_id: org.id },
		select: { id: true, name: true },
		take: 3,
	});
	const visits = await db.job_visit.findMany({
		where: { job: { organization_id: org.id } },
		select: { id: true },
		take: 5,
	});
	if (!techs.length || !visits.length) throw new Error("Org needs at least 1 technician and 1 visit");

	const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: tz }) + "T00:00:00Z");
	const lastMonday = new Date(today);
	lastMonday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7) - 7 * weeksAgo);

	let created = 0;
	for (let d = 0; d < 5; d++) {
		const day = new Date(lastMonday);
		day.setUTCDate(lastMonday.getUTCDate() + d);
		const dateStr = day.toISOString().slice(0, 10);

		for (const [i, tech] of techs.entries()) {
			const plan = DAY_PLANS[(i * 2 + d) % DAY_PLANS.length];
			if (!plan) continue;
			const breakHours = plan.breaks.reduce((h, b) => h + b.to - b.from, 0);
			const unpaidHours = plan.breaks.filter((b) => !b.paid).reduce((h, b) => h + b.to - b.from, 0);
			const dayStart = atLocal(dateStr, 0, tz);
			const exists = await db.technician_shift.findFirst({
				where: { tech_id: tech.id, started_at: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } },
			});
			if (exists) continue;

			await db.$transaction(async (tx) => {
				const shift = await tx.technician_shift.create({
					data: {
						tech_id: tech.id,
						org_id: org.id,
						started_at: atLocal(dateStr, plan.start, tz),
						ended_at: atLocal(dateStr, plan.end, tz),
						gross_hours: plan.end - plan.start,
						break_hours: breakHours,
						payable_hours: plan.end - plan.start - unpaidHours,
					},
				});
				await tx.technician_shift_break.createMany({
					data: plan.breaks.map((b) => ({
						shift_id: shift.id,
						tech_id: tech.id,
						reason: b.reason,
						is_paid: b.paid,
						pre_break_status: "Working",
						started_at: atLocal(dateStr, b.from, tz),
						ended_at: atLocal(dateStr, b.to, tz),
						duration_hrs: b.to - b.from,
					})),
				});
				await tx.visit_tech_time_entry.createMany({
					data: plan.visits.map(([from, to], n) => ({
						visit_id: visits[n % visits.length].id,
						tech_id: tech.id,
						clocked_in_at: atLocal(dateStr, from, tz),
						clocked_out_at: atLocal(dateStr, to, tz),
						hours_worked: to - from,
					})),
				});
				// Up to 30 min of driving before each visit, starting no earlier than the previous visit's end
				await tx.visit_tech_drive.createMany({
					data: plan.visits.flatMap(([from], n) => {
						const driveStart = Math.max(n ? plan.visits[n - 1][1] : plan.start, from - 0.5);
						return driveStart < from
							? [{
									visit_id: visits[n % visits.length].id,
									tech_id: tech.id,
									started_at: atLocal(dateStr, driveStart, tz),
									ended_at: atLocal(dateStr, from, tz),
								}]
							: [];
					}),
				});
			});
			created++;
		}
	}

	console.log(`${org.name}: ${created} shifts added for week of ${lastMonday.toISOString().slice(0, 10)} (${techs.map((t) => t.name).join(", ")})`);
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
