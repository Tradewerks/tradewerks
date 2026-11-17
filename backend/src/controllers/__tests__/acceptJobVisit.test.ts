import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb } = vi.hoisted(() => {
	const sdb = {
		job_visit: { findFirst: vi.fn() },
		technician: { findFirst: vi.fn() },
		job_visit_technician: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
		$queryRaw: vi.fn(),
		$transaction: vi.fn(),
	};
	sdb.$transaction.mockImplementation(async (cb: (tx: typeof sdb) => unknown) => cb(sdb));
	return { sdb };
});

vi.mock("../../lib/context.js", () => ({ getScopedDb: () => sdb }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/socketService.js", () => ({ emitToOrg: vi.fn() }));
vi.mock("../../services/entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
// Cut the email import chain (same as jobVisitInventory.test.ts).
vi.mock("../inventoryController.js", () => ({ deductInventoryForVisit: vi.fn() }));
vi.mock("../../services/lowStockAlerts.js", () => ({ fireLowStockAlerts: vi.fn(), sendLowStockAlert: vi.fn() }));

import { acceptJobVisit } from "../jobVisitsController.js";

beforeEach(() => {
	vi.clearAllMocks();
	sdb.job_visit.findFirst.mockResolvedValue({ id: "v1", job_id: "j1", status: "Scheduled" });
	sdb.technician.findFirst.mockResolvedValue({ id: "tech-1" });
	sdb.job_visit_technician.findFirst.mockResolvedValue(null);
});

describe("acceptJobVisit — technicians only claim unassigned visits", () => {
	it("refuses a tech when the visit already has someone, after locking the row", async () => {
		sdb.job_visit_technician.count.mockResolvedValue(1);
		const r = await acceptJobVisit("v1", "tech-1", "org-1", { techId: "tech-1" });
		expect(r.err).toBe("This visit already has a technician. Ask a dispatcher to add you to it.");
		expect(sdb.$queryRaw).toHaveBeenCalled();
		expect(sdb.job_visit_technician.create).not.toHaveBeenCalled();
	});

	it("lets a tech claim an unassigned visit", async () => {
		sdb.job_visit_technician.count.mockResolvedValue(0);
		const r = await acceptJobVisit("v1", "tech-1", "org-1", { techId: "tech-1" });
		expect(r.err).toBe("");
		expect(sdb.job_visit_technician.create).toHaveBeenCalled();
	});

	it("lets a dispatcher add a tech to an already-staffed visit", async () => {
		sdb.job_visit_technician.count.mockResolvedValue(1);
		const r = await acceptJobVisit("v1", "tech-2", "org-1", { dispatcherId: "d1" });
		expect(r.err).toBe("");
		expect(sdb.$queryRaw).not.toHaveBeenCalled();
		expect(sdb.job_visit_technician.create).toHaveBeenCalled();
	});

	it("refuses a closed visit", async () => {
		sdb.job_visit.findFirst.mockResolvedValue({ id: "v1", job_id: "j1", status: "Completed" });
		const r = await acceptJobVisit("v1", "tech-1", "org-1", { techId: "tech-1" });
		expect(r.err).toBe("Completed visits can't be accepted");
	});
});
