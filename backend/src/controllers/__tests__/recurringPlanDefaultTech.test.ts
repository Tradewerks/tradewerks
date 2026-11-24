import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	generateVisitFromOccurrence,
	insertRecurringPlan,
	updateRecurringPlan,
} from "../recurringPlansController.js";
import { createRecurringPlanSchema } from "../../lib/validate/recurringPlans.js";
import { getScopedDb } from "../../lib/context.js";
import { createNotification } from "../notificationsController.js";

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../db.js", () => ({
	db: {},
	generateJobNumber: vi.fn().mockResolvedValue("J-0001"),
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../notificationsController.js", () => ({
	createNotification: vi.fn(async () => undefined),
}));
vi.mock("../../services/socketService.js", () => ({
	emitToOrg: vi.fn(),
	getSocket: vi.fn(),
}));
vi.mock("../../services/visitLifecycle/index.js", () => ({
	syncJobFromVisits: vi.fn(async () => null),
	runJobChangePostCommit: vi.fn(async () => undefined),
}));

const ORG = "org-1";
const TECH = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-23T18:00:00Z");

function setupGenerate(opts: {
	defaultTech?: string | null;
	techRow?: { id: string; name: string } | null;
}) {
	const tx = {
		$queryRaw: vi.fn(async () => [{ status: "Active" }]),
		recurring_plan_line_item: { findMany: vi.fn(async () => []) },
		technician: {
			findFirst: vi.fn(async () => opts.techRow ?? null),
		},
		job: { findFirst: vi.fn(async () => null) },
		job_visit: {
			create: vi.fn(async () => ({
				id: "visit-1",
				scheduled_start_at: NOW,
				scheduled_end_at: NOW,
			})),
		},
		recurring_occurrence: {
			updateMany: vi.fn(async () => ({ count: 1 })),
			findUnique: vi.fn(async () => ({
				id: "occ-1",
				status: "planned",
				job_visit_id: null,
				occurrence_start_at: NOW,
				occurrence_end_at: NOW,
				template_version: 1,
			})),
		},
		log: { create: vi.fn(async () => ({ id: "log-1", event_type: "x" })) },
	};
	const sdb = {
		recurring_occurrence: {
			findUnique: vi.fn(async () => ({
				id: "occ-1",
				status: "planned",
				job_visit_id: null,
				occurrence_start_at: NOW,
				occurrence_end_at: NOW,
				template_version: 1,
				recurring_plan: {
					id: "plan-1",
					organization_id: ORG,
					status: "Active",
					default_technician_id: opts.defaultTech ?? null,
					job_container: { id: "job-1", tax_rate: 0 },
					line_items: [],
					rules: [{}],
				},
			})),
		},
		$transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
	};
	vi.mocked(getScopedDb).mockReturnValue(sdb as never);
	return { tx, sdb };
}

describe("recurring plan default technician", () => {
	beforeEach(() => vi.clearAllMocks());

	it("generated visit is assigned the plan's default technician", async () => {
		const { tx } = setupGenerate({
			defaultTech: TECH,
			techRow: { id: TECH, name: "Tess" },
		});

		const res = await generateVisitFromOccurrence("occ-1", ORG);

		expect(res.err).toBe("");
		expect(tx.technician.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: TECH,
					organization_id: ORG,
					deactivated_at: null,
				}),
			}),
		);
		const [{ data }] = tx.job_visit.create.mock.calls[0] as unknown as [
			{ data: { visit_techs?: unknown } },
		];
		expect(data.visit_techs).toEqual({ create: [{ tech_id: TECH }] });
		// Same notice a dispatcher's manual assignment sends, after commit.
		expect(createNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				technicianId: TECH,
				type: "visit_assigned",
			}),
			ORG,
		);
	});

	it("an inactive default technician leaves the visit unassigned", async () => {
		const { tx } = setupGenerate({ defaultTech: TECH, techRow: null });

		const res = await generateVisitFromOccurrence("occ-1", ORG);

		expect(res.err).toBe("");
		const [{ data }] = tx.job_visit.create.mock.calls[0] as unknown as [
			{ data: { visit_techs?: unknown } },
		];
		expect(data.visit_techs).toBeUndefined();
		expect(createNotification).not.toHaveBeenCalled();
	});

	it("the generation log row is written on the transaction", async () => {
		const { tx } = setupGenerate({});
		await generateVisitFromOccurrence("occ-1", ORG);
		expect(tx.log.create).toHaveBeenCalledTimes(1);
	});

	it("a default technician from another org is rejected", async () => {
		const tx = {
			technician: { findFirst: vi.fn(async () => null) },
			client: {
				findUnique: vi.fn(async () => ({
					id: "c",
					organization_id: ORG,
				})),
			},
			organization: {
				findFirst: vi.fn(async () => ({ timezone: "UTC" })),
			},
		};
		vi.mocked(getScopedDb).mockReturnValue({
			$transaction: vi.fn(async (cb: (t: typeof tx) => unknown) =>
				cb(tx),
			),
			recurring_plan: {
				findFirst: vi.fn(async () => ({
					id: "plan-1",
					organization_id: ORG,
					default_technician_id: null,
					rules: [],
					line_items: [],
				})),
			},
		} as never);

		const created = await insertRecurringPlan(
			{
				body: {
					client_id: "22222222-2222-4222-8222-222222222222",
					name: "n",
					description: "d",
					address: "a",
					coords: { lat: 1, lon: 2 },
					starts_at: NOW.toISOString(),
					default_technician_id: TECH,
					rule: {
						frequency: "daily",
						interval: 1,
						arrival_constraint: "anytime",
						finish_constraint: "when_done",
					},
				},
			} as never,
			ORG,
		);
		expect(created.err).toMatch(/technician/i);
		expect(tx.technician.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: TECH,
					organization_id: ORG,
				}),
			}),
		);

		const updated = await updateRecurringPlan(
			"job-1",
			{ default_technician_id: TECH },
			ORG,
		);
		expect(updated.err).toMatch(/technician/i);
	});

	it("accepts default_technician_id on the create schema", () => {
		const base = {
			client_id: "22222222-2222-4222-8222-222222222222",
			name: "n",
			description: "d",
			address: "a",
			coords: { lat: 1, lon: 2 },
			starts_at: NOW.toISOString(),
			rule: {
				frequency: "daily",
				interval: 1,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
			},
		};
		expect(
			createRecurringPlanSchema.parse({
				...base,
				default_technician_id: TECH,
			}).default_technician_id,
		).toBe(TECH);
		expect(
			createRecurringPlanSchema.parse({
				...base,
				default_technician_id: null,
			}).default_technician_id,
		).toBeNull();
	});
});
