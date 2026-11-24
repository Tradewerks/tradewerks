import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../services/entitlementService.js", () => ({
	getEntitlements: vi.fn(async () => ({ modules: {} })),
}));
vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../controllers/reportsController.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getDashboardToday: vi.fn(async () => ({})),
}));

import reportsRouter from "../reports.js";
import { getDashboardToday } from "../../controllers/reportsController.js";
import { callRoute } from "./harness.js";

beforeEach(() => vi.clearAllMocks());

const visitsGate = () =>
	(vi.mocked(getDashboardToday).mock.calls[0][3] as { visits: boolean }).visits;

describe("GET /reports/dashboard-today visit tiles", () => {
	it("are null for an assigned-only caller even with view_visits", async () => {
		const r = await callRoute(reportsRouter, "get", "/dashboard-today", {
			user: { uid: "tech-1", role: "technician", permissions: ["view_assigned_jobs", "view_visits"] },
		});
		expect(r.status).toBe(200);
		expect(visitsGate()).toBe(false);
	});

	it("stay on for a view_jobs caller", async () => {
		await callRoute(reportsRouter, "get", "/dashboard-today", {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_jobs"] },
		});
		expect(visitsGate()).toBe(true);
	});
});
