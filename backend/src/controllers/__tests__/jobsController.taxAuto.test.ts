import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, taxMode, recomputeJobTotals, recomputeDocumentTotals } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		job: { findFirst: vi.fn(), update: vi.fn() },
		job_visit: { findMany: vi.fn(async () => []) },
		invoice: { findMany: vi.fn(async () => []) },
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return {
		mockDb,
		taxMode: vi.fn(async () => "manual"),
		recomputeJobTotals: vi.fn(async () => ({ ok: true })),
		recomputeDocumentTotals: vi.fn(async () => ({ ok: true })),
	};
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateJobNumber: vi.fn(async () => "J-0042"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn(() => ({ emit: vi.fn() })),
	emitToOrg: vi.fn(),
}));

vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(),
}));

// The real dropClientTaxTotals, so auto mode genuinely strips client totals.
vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
	getEffectiveTaxMode: taxMode,
}));

vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeJobTotals,
	recomputeDocumentTotals,
	holdsKeptRate: vi.fn(async () => false),
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { buildChanges } from "../../services/logger.js";
import { updateJob } from "../jobsController.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const TOTAL_KEYS = ["subtotal", "tax_amount", "estimated_total"];
const body = {
	address: "2 Oak St",
	coords: { lat: 30.3, lon: -97.8 },
	subtotal: 100,
	tax_amount: 8,
	estimated_total: 108,
};
const edit = () =>
	updateJob({ params: { id: "j1" }, body } as unknown as Request, "org1", {
		dispatcherId: "d1",
	});

describe("updateJob tax totals (Review Focus 2)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.job.findFirst).mockResolvedValue({
			id: "j1",
			address: "1 Main St",
			line_items: [],
		});
		mockFn(db.job.update).mockResolvedValue({ id: "j1" });
	});

	it("auto mode: drops client totals from the write and the log, and recomputes on the tx", async () => {
		taxMode.mockResolvedValueOnce("auto");

		const result = await edit();

		expect(result.err).toBe("");
		for (const [arg] of mockFn(db.job.update).mock.calls) {
			for (const k of TOTAL_KEYS) expect(arg.data).not.toHaveProperty(k);
		}
		const logged = mockFn(buildChanges).mock.calls[0][1];
		for (const k of TOTAL_KEYS) expect(logged).not.toHaveProperty(k);
		expect(recomputeJobTotals).toHaveBeenCalledWith("j1", "org1", mockDb);
	});

	it("manual mode: writes client totals as before and does not recompute", async () => {
		const result = await edit();

		expect(result.err).toBe("");
		expect(db.job.update).toHaveBeenCalledTimes(1);
		expect(mockFn(db.job.update).mock.calls[0][0].data).toMatchObject({
			address: "2 Oak St",
			subtotal: 100,
			tax_amount: 8,
			estimated_total: 108,
		});
		expect(mockFn(buildChanges).mock.calls[0][1]).toMatchObject({
			subtotal: 100,
			tax_amount: 8,
			estimated_total: 108,
		});
		expect(recomputeJobTotals).not.toHaveBeenCalled();
	});
});

describe("updateJob open-visit recompute", () => {
	const patch = (data: object) =>
		updateJob({ params: { id: "j1" }, body: data } as unknown as Request, "org1", {
			dispatcherId: "d1",
		});

	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.job.findFirst).mockResolvedValue({
			id: "j1",
			address: "1 Main St",
			line_items: [],
		});
		mockFn(db.job.update).mockResolvedValue({ id: "j1" });
		// The status filter is the database's job; the mock stands in for it returning open visits only.
		mockFn(mockDb.job_visit.findMany).mockResolvedValue([{ id: "v-open" }]);
	});

	it("auto mode: an address change recomputes the open visits too", async () => {
		taxMode.mockResolvedValueOnce("auto");

		await patch({ address: "2 Oak St", coords: { lat: 30.3, lon: -97.8 } });

		expect(recomputeDocumentTotals).toHaveBeenCalledWith("job_visit", "v-open", "org1", mockDb);
	});

	it("auto mode: a discount-only change leaves visits alone", async () => {
		taxMode.mockResolvedValueOnce("auto");

		await patch({ discount_type: "percent", discount_value: 5 });

		expect(recomputeDocumentTotals).not.toHaveBeenCalled();
	});

	it("manual mode: an address change does not touch visits", async () => {
		await patch({ address: "2 Oak St", coords: { lat: 30.3, lon: -97.8 } });

		expect(recomputeDocumentTotals).not.toHaveBeenCalled();
	});

	it("a visit recompute failure never fails the save", async () => {
		taxMode.mockResolvedValueOnce("auto");
		recomputeDocumentTotals.mockRejectedValueOnce(new Error("boom"));

		const result = await patch({ address: "2 Oak St", coords: { lat: 30.3, lon: -97.8 } });

		expect(result.err).toBe("");
	});
});
