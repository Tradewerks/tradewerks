import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: vi.fn(async () => []),
}));
vi.mock("../emailService.js", () => ({ sendTrialEndingEmail: vi.fn(async () => {}) }));

import { db } from "../../db.js";
import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { sendTrialEndingEmail } from "../emailService.js";
import { dueWarning, runTrialWarnings } from "../trialScheduler.js";

const mockDb = db as any;
const notify = notifyDispatchers as unknown as ReturnType<typeof vi.fn>;
const NOW = new Date("2026-10-20T12:00:00Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const row = (endsAt: Date, over: Record<string, unknown> = {}) => ({
	organization_id: "org-1",
	trial_ends_at: endsAt,
	trial_warned_3d_at: null,
	trial_warned_end_at: null,
	organization: { name: "Acme", timezone: "America/Chicago" },
	plan_version: { modules: ["quotes"], plan: { label: "Starter" } },
	trial_plan_version: {
		modules: ["quotes", "quickbooks", "ai_assistant"],
		plan: { label: "Enterprise" },
	},
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.$executeRaw.mockResolvedValue(1);
	mockDb.dispatcher.findMany.mockResolvedValue([{ email: "admin@acme.test" }]);
});

describe("dueWarning", () => {
	it.each([
		[73, null],
		[72, "3d"],
		[48, "3d"],
		[24.01, "3d"],
		[24, "end"],
		[20, "end"],
		[0, null],
		[-1, null],
	])("%s h left → %s", (h, want) => {
		expect(dueWarning(at(h as number), NOW)).toBe(want);
	});
});

describe("runTrialWarnings", () => {
	it("claims the 3-day warning with raw SQL, then notifies and emails admins", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([row(at(48))]);
		expect(await runTrialWarnings(NOW)).toBe(1);
		expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
		const [n, orgId] = notify.mock.calls[0];
		expect(orgId).toBe("org-1");
		expect(n.type).toBe("trial_ending");
		expect(n.title).toBe("Your Enterprise trial ends Oct 22");
		expect(n.body).toBe("QuickBooks and AI Assistant stop then. Your data is kept.");
		expect((sendTrialEndingEmail as any).mock.calls[0][0]).toEqual(["admin@acme.test"]);
	});

	it("sends nothing when another instance won the claim", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([row(at(48))]);
		mockDb.$executeRaw.mockResolvedValue(0);
		expect(await runTrialWarnings(NOW)).toBe(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("skips a warning already sent", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([row(at(48), { trial_warned_3d_at: NOW })]);
		expect(await runTrialWarnings(NOW)).toBe(0);
		expect(mockDb.$executeRaw).not.toHaveBeenCalled();
	});

	it("a trial with under 24 h left gets only the last-day warning", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([row(at(20))]);
		await runTrialWarnings(NOW);
		expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
		expect(mockDb.$executeRaw.mock.calls[0][0].join("?")).toContain("trial_warned_end_at");
	});

	it("passes the trial_ends_at it read to the claim, so a moved trial is skipped", async () => {
		const ends = at(48);
		mockDb.org_entitlement.findMany.mockResolvedValue([row(ends)]);
		await runTrialWarnings(NOW);
		expect(mockDb.$executeRaw.mock.calls[0]).toContain(ends);
	});

	it("names no features when the trial adds none", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([
			row(at(48), { trial_plan_version: { modules: ["quotes"], plan: { label: "Pro" } } }),
		]);
		await runTrialWarnings(NOW);
		expect(notify.mock.calls[0][0].body).toBe("Your data is kept.");
	});

	it("leaves out a module a staff grant keeps on after the trial", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([
			row(at(48), { module_grants: { quickbooks: "on" } }),
		]);
		await runTrialWarnings(NOW);
		expect(notify.mock.calls[0][0].body).toBe("AI Assistant stops then. Your data is kept.");
	});

	it("leaves out a module the org switched off", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([
			row(at(48), { module_choices: { ai_assistant: false } }),
		]);
		await runTrialWarnings(NOW);
		expect(notify.mock.calls[0][0].body).toBe("QuickBooks stops then. Your data is kept.");
	});

	it("one failing org does not stop the run", async () => {
		mockDb.org_entitlement.findMany.mockResolvedValue([
			row(at(48)),
			row(at(48), { organization_id: "org-2" }),
		]);
		notify.mockRejectedValueOnce(new Error("boom"));
		expect(await runTrialWarnings(NOW)).toBe(1);
	});
});
