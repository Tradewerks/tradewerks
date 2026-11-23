import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/requirePermissions.js", () => ({
    requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
    requireAnyPermission:
        () => (_req: unknown, _res: unknown, next: () => void) =>
            next(),
}));
vi.mock("../../db.js", async () => ({
    db: (await import("./harness.js")).createFakeDb(),
}));
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
    cancelJob: vi.fn(),
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
    imageUpload: {
        single: () => (_req: unknown, _res: unknown, next: () => void) =>
            next(),
    },
}));
vi.mock("../../services/wasabiService.js", () => ({
    uploadFile: vi.fn(),
    signImageUrl: vi.fn(),
    isOwnBucketUrl: vi.fn(() => true),
}));

import jobsRouter from "../jobs.js";
import { cancelJob, insertJob } from "../../controllers/jobsController.js";
import { callRoute } from "./harness.js";

describe("POST /jobs refusals", () => {
    beforeEach(() => vi.mocked(insertJob).mockReset());

    it.each([
        ["NOT_FOUND", 404],
        ["WRONG_STATE", 409],
        ["CONFLICT", 409],
    ] as const)("%s answers %i", async (code, status) => {
        vi.mocked(insertJob).mockResolvedValue({ err: "nope", code });
        const res = await callRoute(jobsRouter, "post", "/", {
            body: {},
        });
        expect(res.status).toBe(status);
        expect(res.body.error.code).toBe(code);
    });

    it("400 for a refusal without a code", async () => {
        vi.mocked(insertJob).mockResolvedValue({ err: "bad plan" });
        const res = await callRoute(jobsRouter, "post", "/", { body: {} });
        expect(res.status).toBe(400);
    });
});

describe("POST /jobs/:id/cancel", () => {
    beforeEach(() => vi.mocked(cancelJob).mockReset());

    it("400 without a reason", async () => {
        for (const body of [{}, { reason: "   " }]) {
            const res = await callRoute(jobsRouter, "post", "/:id/cancel", {
                params: { id: "j1" },
                body,
            });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("VALIDATION_ERROR");
        }
        expect(cancelJob).not.toHaveBeenCalled();
    });

    it("409 on a Completed job", async () => {
        vi.mocked(cancelJob).mockResolvedValue({
            err: "This job is complete. Cancel its invoice instead.",
            code: "WRONG_STATE",
        });
        const res = await callRoute(jobsRouter, "post", "/:id/cancel", {
            params: { id: "j1" },
            body: { reason: "Customer called" },
        });
        expect(res.status).toBe(409);
        expect(res.body.error.message).toBe(
            "This job is complete. Cancel its invoice instead.",
        );
        expect(cancelJob).toHaveBeenCalledWith(
            "j1",
            "Customer called",
            "org-1",
            { dispatcherId: "disp-1" },
        );
    });

    it("403 for a technician caller", async () => {
        vi.mocked(cancelJob).mockResolvedValue({
            err: "Technicians can't cancel jobs.",
            code: "FORBIDDEN",
        });
        const res = await callRoute(jobsRouter, "post", "/:id/cancel", {
            params: { id: "j1" },
            body: { reason: "x" },
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("404 when the job is not in the org", async () => {
        vi.mocked(cancelJob).mockResolvedValue({
            err: "Job not found",
            code: "NOT_FOUND",
        });
        const res = await callRoute(jobsRouter, "post", "/:id/cancel", {
            params: { id: "j1" },
            body: { reason: "x" },
        });
        expect(res.status).toBe(404);
    });
});
