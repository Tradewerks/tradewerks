import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	recurring_plan_id: string;
	frequency: string;
	billing_basis: string;
	day_of_month: number | null;
	day_of_week: string | null;
	generate_days_before: number;
	next_invoice_at: Date | null;
	last_invoiced_at: Date | null;
	last_failure_at: Date | null;
	last_failure_message: string | null;
	is_active: boolean;
	recurring_plan: {
		id: string;
		organization_id: string;
		client_id: string;
		name: string;
		status: string;
		timezone: string;
		starts_at: Date;
		ends_at: Date | null;
	};
};

const { rows, invoiceSchedule, planStatusLock, txJournal } = vi.hoisted(() => {
	const rows: Row[] = [];
	// Writes made inside the open mock transaction, so a throw can undo just
	// those. A test's own mutation stands in for another instance that
	// committed once our rollback released the row, so a field it has since
	// overwritten is left as it set it.
	const txJournal: { open: boolean; undo: (() => void)[] } = { open: false, undo: [] };
	const write = (r: Row, data: Partial<Row>) => {
		const rec = r as unknown as Record<string, unknown>;
		if (txJournal.open) {
			const prev = Object.fromEntries(Object.keys(data).map((k) => [k, rec[k]]));
			txJournal.undo.push(() => {
				for (const [k, v] of Object.entries(data)) {
					if (rec[k] === v) rec[k] = prev[k];
				}
			});
		}
		Object.assign(r, data);
	};

	function applyWhere(r: Row, where: Record<string, unknown>): boolean {
		for (const [k, v] of Object.entries(where)) {
			if (k === "recurring_plan") {
				const status = (v as { status?: string }).status;
				if (status !== undefined && r.recurring_plan.status !== status) return false;
				continue;
			}
			const actual = (r as unknown as Record<string, unknown>)[k];
			if (v instanceof Date || v === null) {
				const a = actual instanceof Date ? actual.getTime() : actual;
				const b = v instanceof Date ? v.getTime() : v;
				if (a !== b) return false;
				continue;
			}
			if (typeof v === "object") {
				const op = v as { lte?: Date; not?: unknown };
				if (op.lte && !(actual instanceof Date && actual <= op.lte)) return false;
				if ("not" in op && actual === op.not) return false;
				continue;
			}
			if (actual !== v) return false;
		}
		return true;
	}

	const invoiceSchedule = {
		findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
			rows.filter((r) => applyWhere(r, args.where)).map((r) => ({ ...r })),
		),
		update: vi.fn(async (args: { where: { id: string }; data: Partial<Row> }) => {
			const r = rows.find((x) => x.id === args.where.id)!;
			write(r, args.data);
			return r;
		}),
		updateMany: vi.fn(
			async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
				const hit = rows.filter((r) => applyWhere(r, args.where));
				for (const r of hit) write(r, args.data);
				return { count: hit.length };
			},
		),
	};
	// The in-tx `SELECT status ... FOR SHARE`: answers from the live row.
	const planStatusLock = vi.fn(async (_sql: unknown, planId: string) => {
		const r = rows.find((x) => x.recurring_plan.id === planId);
		return r ? [{ status: r.recurring_plan.status }] : [];
	});
	return { rows, invoiceSchedule, planStatusLock, txJournal };
});

vi.mock("../../db.js", () => ({
	db: {
		invoice_schedule: invoiceSchedule,
		// Undoes its own writes on a throw, as the real transaction would.
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
			txJournal.open = true;
			txJournal.undo = [];
			try {
				return await fn({ invoice_schedule: invoiceSchedule, $queryRaw: planStatusLock });
			} catch (e) {
				for (const u of txJournal.undo.reverse()) u();
				throw e;
			} finally {
				txJournal.open = false;
			}
		}),
	},
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => ({})) }));
vi.mock("../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../invoiceGenerator.js", () => ({
	buildRecurringPlanInvoicePayload: vi.fn(),
}));
vi.mock("../invoiceService.js", () => ({
	createInvoiceRecord: vi.fn(async () => ({
		id: "inv-1",
		invoice_number: "INV-1001",
		client_id: "c1",
		total: 100,
		status: "Draft",
		recurring_plan_id: "plan-1",
	})),
}));
vi.mock("../logger.js", () => ({
	logActivity: vi.fn(async () => undefined),
}));
vi.mock("../appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../controllers/notificationsController.js", async (orig) => ({
	...(await orig<typeof import("../../controllers/notificationsController.js")>()),
	notifyDispatchers: vi.fn(async () => []),
}));

import { runScheduledInvoiceGeneration } from "../invoiceScheduler.js";
import { buildRecurringPlanInvoicePayload } from "../invoiceGenerator.js";
import { createInvoiceRecord } from "../invoiceService.js";
import {
	DISPATCHER_NOTIFICATION_PERMISSIONS,
	notifyDispatchers,
} from "../../controllers/notificationsController.js";

const CHI = "America/Chicago";

function seed(over: Partial<Row> = {}, plan: Partial<Row["recurring_plan"]> = {}) {
	rows.push({
		id: "sched-1",
		recurring_plan_id: "plan-1",
		frequency: "monthly",
		billing_basis: "plan_line_items",
		day_of_month: 1,
		day_of_week: null,
		generate_days_before: 0,
		next_invoice_at: new Date("2026-11-01T05:00:00Z"),
		last_invoiced_at: new Date("2026-10-01T05:05:00Z"),
		last_failure_at: null,
		last_failure_message: null,
		is_active: true,
		...over,
		recurring_plan: {
			id: "plan-1",
			organization_id: "org-1",
			client_id: "c1",
			name: "Gold Maintenance",
			status: "Active",
			timezone: CHI,
			starts_at: new Date("2026-01-01T06:00:00Z"),
			ends_at: null,
			...plan,
		},
	});
	return rows[rows.length - 1];
}

function payload(empty = false) {
	return {
		payload: { client_id: "c1", recurring_plan_id: "plan-1", line_items: [] },
		warnings: [],
		empty,
	};
}

beforeEach(() => {
	rows.length = 0;
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-01T06:00:00Z"));
	vi.mocked(buildRecurringPlanInvoicePayload).mockResolvedValue(
		payload() as never,
	);
	vi.mocked(createInvoiceRecord).mockResolvedValue({
		id: "inv-1",
		invoice_number: "INV-1001",
		client_id: "c1",
		total: 100,
		status: "Draft",
		recurring_plan_id: "plan-1",
	} as never);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("runScheduledInvoiceGeneration", () => {
	it("a paused plan's due schedule produces no invoice", async () => {
		const row = seed({}, { status: "Paused" });

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).not.toHaveBeenCalled();
		// Left due: resume recomputes a past date from today, so nothing replays.
		expect(row.next_invoice_at!.toISOString()).toBe("2026-11-01T05:00:00.000Z");
	});

	it("a plan paused after the due list was read is not billed", async () => {
		const row = seed();
		vi.mocked(buildRecurringPlanInvoicePayload).mockImplementationOnce(async () => {
			row.recurring_plan.status = "Paused";
			return payload() as never;
		});

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect(row.next_invoice_at!.toISOString()).toBe("2026-11-01T05:00:00.000Z");
		expect(row.last_failure_at).toBeNull();
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("a schedule switched off after the due list was read is not billed", async () => {
		const row = seed();
		vi.mocked(buildRecurringPlanInvoicePayload).mockImplementationOnce(async () => {
			row.is_active = false;
			return payload() as never;
		});

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect(row.next_invoice_at!.toISOString()).toBe("2026-11-01T05:00:00.000Z");
		expect(row.last_failure_at).toBeNull();
	});

	it("the plan row is share-locked before the schedule is claimed", async () => {
		seed();
		const order: string[] = [];
		planStatusLock.mockImplementationOnce(async () => {
			order.push("plan");
			return [{ status: "Active" }];
		});
		invoiceSchedule.updateMany.mockImplementationOnce(async () => {
			order.push("schedule");
			return { count: 1 };
		});
		vi.mocked(createInvoiceRecord).mockImplementationOnce(async () => {
			order.push("invoice");
			return { id: "inv-1", invoice_number: "INV-1001" } as never;
		});

		await runScheduledInvoiceGeneration();

		expect(order).toEqual(["plan", "schedule", "invoice"]);
		expect(String(planStatusLock.mock.calls[0][0])).toMatch(/FOR SHARE/);
	});

	it("a schedule past the plan's ends_at is deactivated without invoicing", async () => {
		// Ends Oct 31 local; the Nov 1 period falls after it.
		const row = seed({}, { ends_at: new Date("2026-10-31T22:00:00Z") });

		await runScheduledInvoiceGeneration();

		expect(buildRecurringPlanInvoicePayload).not.toHaveBeenCalled();
		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect(row.is_active).toBe(false);
		expect(row.next_invoice_at!.toISOString()).toBe("2026-11-01T05:00:00.000Z");
	});

	it("a period billed after ends_at is deactivated even when generated before it", async () => {
		// Monthly day 1, gdb 5: the Dec 1 period generates Nov 26; plan ends Nov 30.
		vi.setSystemTime(new Date("2026-11-26T07:00:00Z"));
		const row = seed(
			{
				generate_days_before: 5,
				next_invoice_at: new Date("2026-11-26T06:00:00Z"),
			},
			{ ends_at: new Date("2026-11-30T22:00:00Z") },
		);

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect(row.is_active).toBe(false);
	});

	it("a period billed on ends_at still bills", async () => {
		vi.setSystemTime(new Date("2026-11-26T07:00:00Z"));
		seed(
			{
				generate_days_before: 5,
				next_invoice_at: new Date("2026-11-26T06:00:00Z"),
			},
			{ ends_at: new Date("2026-12-01T22:00:00Z") },
		);

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).toHaveBeenCalledTimes(1);
	});

	it("one schedule with a bad timezone does not stop the next", async () => {
		seed({ id: "sched-bad", recurring_plan_id: "plan-bad" }, { id: "plan-bad", timezone: "Not/AZone" });
		const good = seed({ id: "sched-2", recurring_plan_id: "plan-2" }, { id: "plan-2" });

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).toHaveBeenCalledTimes(1);
		expect(good.next_invoice_at!.toISOString()).toBe("2026-12-01T06:00:00.000Z");
		expect(rows[0].last_failure_message).toMatch(/Not\/AZone|time zone/i);
	});

	it("a failure after another run billed the period is not recorded or notified", async () => {
		const row = seed();
		vi.mocked(createInvoiceRecord).mockImplementation(async () => {
			// Another instance billed and advanced the period meanwhile.
			row.last_invoiced_at = new Date("2026-11-01T06:00:00Z");
			row.next_invoice_at = new Date("2026-12-01T06:00:00Z");
			throw new Error("duplicate invoice_number");
		});

		await runScheduledInvoiceGeneration();

		expect(notifyDispatchers).not.toHaveBeenCalled();
		expect(row.last_failure_at).toBeNull();
		expect(row.last_failure_message).toBeNull();
	});

	it("two instances failing the same period notify once", async () => {
		const row = seed();
		vi.mocked(createInvoiceRecord).mockImplementation(async () => {
			// The other instance recorded its failure first.
			row.last_failure_at = new Date("2026-11-01T05:59:00Z");
			row.last_failure_message = "first";
			throw new Error("second");
		});

		await runScheduledInvoiceGeneration();

		expect(notifyDispatchers).not.toHaveBeenCalled();
		expect(row.last_failure_message).toBe("first");
	});

	it("a period on the plan's last day still bills", async () => {
		seed({}, { ends_at: new Date("2026-11-01T22:00:00Z") });

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).toHaveBeenCalledTimes(1);
	});

	it("an empty visit_actuals period advances next_invoice_at without creating an invoice", async () => {
		const row = seed({ billing_basis: "visit_actuals" });
		vi.mocked(buildRecurringPlanInvoicePayload).mockResolvedValue(
			payload(true) as never,
		);

		await runScheduledInvoiceGeneration();

		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect(notifyDispatchers).not.toHaveBeenCalled();
		expect(row.next_invoice_at!.toISOString()).toBe("2026-12-01T06:00:00.000Z");
		// visit_actuals scopes by last_invoiced_at; no invoice means no move.
		expect(row.last_invoiced_at!.toISOString()).toBe("2026-10-01T05:05:00.000Z");
	});

	it("success notifies recurring_invoice_created once", async () => {
		const row = seed({
			last_failure_at: new Date("2026-10-31T05:00:00Z"),
			last_failure_message: "boom",
		});

		await runScheduledInvoiceGeneration();

		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "recurring_invoice_created",
				title: "Recurring invoice drafted",
				body: "Gold Maintenance: INV-1001 is ready to review",
				actionUrl: "/dispatch/invoices/inv-1",
			},
			"org-1",
		);
		expect(row.next_invoice_at!.toISOString()).toBe("2026-12-01T06:00:00.000Z");
		expect(row.last_failure_at).toBeNull();
		expect(row.last_failure_message).toBeNull();
	});

	it("a failure notifies once per period and records last_failure_message", async () => {
		const row = seed();
		vi.mocked(createInvoiceRecord).mockRejectedValue(
			new Error("Client has no billing address"),
		);

		await runScheduledInvoiceGeneration();
		vi.setSystemTime(new Date("2026-11-01T07:00:00Z"));
		await runScheduledInvoiceGeneration();

		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "recurring_invoice_failed",
				title: "Recurring invoice failed",
				body: "Gold Maintenance: Client has no billing address",
				actionUrl: "/dispatch/recurring-plans/plan-1",
			},
			"org-1",
		);
		expect(row.last_failure_message).toBe("Client has no billing address");
		expect(row.last_failure_at!.toISOString()).toBe("2026-11-01T07:00:00.000Z");
		// Not advanced: the period is retried next run.
		expect(row.next_invoice_at!.toISOString()).toBe("2026-11-01T05:00:00.000Z");
	});

	it("a failure in a later period notifies again", async () => {
		seed({
			last_failure_at: new Date("2026-10-01T06:00:00Z"),
			last_failure_message: "old",
		});
		vi.mocked(createInvoiceRecord).mockRejectedValue(new Error("still broken"));

		await runScheduledInvoiceGeneration();

		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
	});
});

describe("recurring invoice notification permissions", () => {
	it("DISPATCHER_NOTIFICATION_PERMISSIONS maps both recurring invoice types to view_invoices", () => {
		expect(DISPATCHER_NOTIFICATION_PERMISSIONS.recurring_invoice_created).toBe(
			"view_invoices",
		);
		expect(DISPATCHER_NOTIFICATION_PERMISSIONS.recurring_invoice_failed).toBe(
			"view_invoices",
		);
	});
});
