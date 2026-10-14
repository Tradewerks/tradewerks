import { db } from "../db.js";
import { log } from "./appLogger.js";
import { notifyDispatchers } from "../controllers/notificationsController.js";
import { sendTrialEndingEmail } from "./emailService.js";
import { trialOnlyModules } from "./entitlementService.js";
import { SUBSCRIPTION_PATH, getModule } from "../lib/entitlements/registry.js";
import { DAY_MS } from "../lib/dayRange.js";

export function dueWarning(endsAt: Date, now: Date): "3d" | "end" | null {
	const left = endsAt.getTime() - now.getTime();
	if (left <= 0 || left > 3 * DAY_MS) return null;
	return left <= DAY_MS ? "end" : "3d";
}

const joinLabels = (labels: string[]) =>
	labels.length <= 1
		? (labels[0] ?? "")
		: `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

// The claim is the gate: two instances can read the same row; only the one whose UPDATE
// matched sends. Raw SQL so updated_at (a staff draft's stale-check stamp) does not move.
// Matching trial_ends_at skips a trial that staff changed after this run read it.
const claim = (orgId: string, kind: "3d" | "end", endsAt: Date) =>
	kind === "3d"
		? db.$executeRaw`UPDATE "org_entitlement" SET "trial_warned_3d_at" = now() WHERE "organization_id" = ${orgId} AND "trial_warned_3d_at" IS NULL AND "trial_ends_at" = ${endsAt}`
		: db.$executeRaw`UPDATE "org_entitlement" SET "trial_warned_end_at" = now() WHERE "organization_id" = ${orgId} AND "trial_warned_end_at" IS NULL AND "trial_ends_at" = ${endsAt}`;

const versionSelect = {
	plan_key: true,
	version: true,
	modules: true,
	limits: true,
	plan: { select: { label: true } },
} as const;

export async function runTrialWarnings(now = new Date()): Promise<number> {
	// Base client on purpose: the scheduler reads every org's entitlement.
	const rows = await db.org_entitlement.findMany({
		where: {
			trial_plan_version_id: { not: null },
			trial_ends_at: { gt: now, lte: new Date(now.getTime() + 3 * DAY_MS) },
		},
		select: {
			organization_id: true,
			trial_ends_at: true,
			trial_warned_3d_at: true,
			trial_warned_end_at: true,
			module_choices: true,
			module_grants: true,
			limit_overrides: true,
			organization: { select: { name: true, timezone: true } },
			plan_version: { select: versionSelect },
			trial_plan_version: { select: versionSelect },
		},
	});
	let sent = 0;
	for (const r of rows) {
		try {
			const endsAt = r.trial_ends_at;
			const kind = endsAt && dueWarning(endsAt, now);
			if (!endsAt || !kind || !r.trial_plan_version) continue;
			if ((kind === "3d" ? r.trial_warned_3d_at : r.trial_warned_end_at) !== null) continue;
			if ((await claim(r.organization_id, kind, endsAt)) !== 1) continue;

			const date = endsAt.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: r.organization?.timezone ?? "America/Chicago",
			});
			const lost = trialOnlyModules(r, now).map((k) => getModule(k)?.label ?? k);
			const title = `Your ${r.trial_plan_version.plan.label} trial ends ${date}`;
			const body = lost.length
				? `${joinLabels(lost)} ${lost.length === 1 ? "stops" : "stop"} then. Your data is kept.`
				: "Your data is kept.";
			await notifyDispatchers(
				{ type: "trial_ending", title, body, actionUrl: SUBSCRIPTION_PATH },
				r.organization_id,
			);
			const admins = await db.dispatcher.findMany({
				where: { organization_id: r.organization_id, role: "admin", deactivated_at: null },
				select: { email: true },
			});
			// The sender logs its own failures; the claim stays because the in-app notice landed.
			await sendTrialEndingEmail(
				admins.map((a) => a.email),
				title,
				`${title}. ${body}`,
			);
			sent++;
		} catch (err) {
			log.error({ err, orgId: r.organization_id }, "trial warning failed — continuing");
		}
	}
	return sent;
}

export function startTrialSchedulerInterval(): void {
	runTrialWarnings().catch((err) => log.error({ err }, "Trial scheduler startup run failed"));
	setInterval(() => {
		runTrialWarnings().catch((err) => log.error({ err }, "Trial scheduler interval run failed"));
	}, 60 * 60 * 1000);
}
