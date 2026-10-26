import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/requirePermissions.js", () => ({
	requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
	requireAnyPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../db.js", async () => ({ db: (await import("./harness.js")).createFakeDb() }));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));
vi.mock("../../controllers/jobsController.js", () => ({
	getAllJobs: vi.fn(),
	getJobById: vi.fn(),
	insertJob: vi.fn(),
	updateJob: vi.fn(),
	deleteJob: vi.fn(),
}));
vi.mock("../../controllers/jobNotesController.js", () => ({}));
vi.mock("../../controllers/jobVisitsController.js", () => ({}));
vi.mock("../../controllers/invoicesController.js", () => ({}));
vi.mock("../../controllers/recurringPlansController.js", () => ({}));
vi.mock("../../controllers/recurringPlanNotesController.js", () => ({}));
vi.mock("../../controllers/logsController.js", () => ({
	getEntityHistory: vi.fn(),
	parseHistoryLimit: vi.fn(),
	INVALID_HISTORY_LIMIT: Symbol("INVALID_HISTORY_LIMIT"),
}));
vi.mock("../../lib/upload.js", () => ({
	imageUpload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));
vi.mock("../../services/wasabiService.js", () => ({ uploadFile: vi.fn(), signImageUrl: vi.fn() }));

import jobsRouter from "../jobs.js";
import { updateJob } from "../../controllers/jobsController.js";
import { callRoute } from "./harness.js";

describe("PATCH /jobs/:id — address tax choice refusal", () => {
	it("answers 409 with the typed code and the kept-rate details", async () => {
		const details = {
			rate_label: "La Crosse, WI",
			rate: 0.055,
			documents: [{ kind: "job", id: "j1", number: "J-0001" }],
		};
		vi.mocked(updateJob).mockResolvedValue({
			err: "The address changed on a document taxed at a kept address rate. Choose which tax to use.",
			code: "ADDRESS_TAX_CHOICE_REQUIRED",
			details,
			item: undefined,
		} as never);

		const res = await callRoute(jobsRouter, "patch", "/:id", {
			params: { id: "j1" },
			body: { address: "100 N State St" },
		});

		expect(res.status).toBe(409);
		expect(res.body.error).toMatchObject({ code: "ADDRESS_TAX_CHOICE_REQUIRED", details });
	});
});
