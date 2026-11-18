import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/requirePermissions.js", () => ({
    requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
    requireAnyPermission: () =>
        (_req: unknown, _res: unknown, next: () => void) => next(),
    hasPermission: () => true,
}));
vi.mock("../../lib/requireAssigned.js", () => ({
    requireAssigned: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));
vi.mock("../../db.js", async () => ({
    db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", () => ({
    getScopedDb: vi.fn(),
    getUserContext: vi.fn(),
}));
vi.mock("../../controllers/jobVisitsController.js", () => ({
    LIFECYCLE_TRANSITIONS: {},
    updateJobVisit: vi.fn(),
    cancelJobVisit: vi.fn(),
    acceptJobVisit: vi.fn(),
}));
vi.mock("../../controllers/visitTimeEntriesController.js", () => ({
    clockInVisit: vi.fn(),
    clockOutVisit: vi.fn(),
}));
vi.mock("../../controllers/vehiclesController.js", () => ({}));
vi.mock("../../controllers/visitFieldLinesController.js", () => ({}));

import jobVisitsRouter from "../jobVisits.js";
import { getUserContext } from "../../lib/context.js";
import {
    updateJobVisit,
    cancelJobVisit,
    acceptJobVisit,
} from "../../controllers/jobVisitsController.js";
import {
    clockInVisit,
    clockOutVisit,
} from "../../controllers/visitTimeEntriesController.js";
import { callRoute } from "./harness.js";

const asTech = () =>
    vi.mocked(getUserContext).mockReturnValue({ techId: "tech-1" });
const asDispatcher = () =>
    vi.mocked(getUserContext).mockReturnValue({ dispatcherId: "disp-1" });
const call = (
    method: string,
    path: string,
    body: unknown = {},
) => callRoute(jobVisitsRouter, method, path, { params: { id: "v1" }, body });

beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(updateJobVisit).mockResolvedValue({ err: "", item: {} } as never);
    vi.mocked(cancelJobVisit).mockResolvedValue({ err: "", item: {} } as never);
    vi.mocked(acceptJobVisit).mockResolvedValue({ err: "", item: {} } as never);
    vi.mocked(clockInVisit).mockResolvedValue({ err: "", item: {} } as never);
    vi.mocked(clockOutVisit).mockResolvedValue({ err: "", item: {} } as never);
});

describe("technician authorization on visit writes", () => {
    it("PUT /job-visits/:id is 403 for a technician even with update_visit_status", async () => {
        asTech();
        const res = await call("put", "/:id", { status: "Completed" });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({
            success: false,
            data: null,
            error: expect.objectContaining({
                code: "FORBIDDEN",
                message: "Technicians update visits through the visit actions.",
            }),
            meta: expect.anything(),
        });
        expect(updateJobVisit).not.toHaveBeenCalled();
    });

    it("PUT /job-visits/:id still reaches the controller for a dispatcher", async () => {
        asDispatcher();
        const res = await call("put", "/:id", { status: "Scheduled" });
        expect(res.status).toBe(200);
        expect(updateJobVisit).toHaveBeenCalledTimes(1);
    });

    it("POST /job-visits/:id/cancel is 403 for a technician", async () => {
        asTech();
        const res = await call("post", "/:id/cancel", {
            cancellation_reason: "x",
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("FORBIDDEN");
        expect(cancelJobVisit).not.toHaveBeenCalled();
    });

    it("clock-in uses the caller's tech id and 403s a different body tech_id", async () => {
        asTech();
        const ok = await call("post", "/:id/clock-in", {});
        expect(ok.status).toBe(201);
        expect(clockInVisit).toHaveBeenCalledWith(
            "v1",
            "tech-1",
            "org-1",
            expect.anything(),
        );
        vi.mocked(clockInVisit).mockClear();
        const bad = await call("post", "/:id/clock-in", { tech_id: "tech-2" });
        expect(bad.status).toBe(403);
        expect(clockInVisit).not.toHaveBeenCalled();
    });

    it("clock-out uses the caller's tech id and 403s a different body tech_id", async () => {
        asTech();
        const ok = await call("post", "/:id/clock-out", {});
        expect(ok.status).toBe(200);
        expect(clockOutVisit).toHaveBeenCalledWith(
            "v1",
            "tech-1",
            "org-1",
            expect.anything(),
            undefined,
        );
        vi.mocked(clockOutVisit).mockClear();
        const bad = await call("post", "/:id/clock-out", { tech_id: "tech-2" });
        expect(bad.status).toBe(403);
        expect(clockOutVisit).not.toHaveBeenCalled();
    });

    it("accept uses the caller's tech id and 403s a different body tech_id", async () => {
        asTech();
        const ok = await call("post", "/:id/accept", {});
        expect(ok.status).toBe(200);
        expect(acceptJobVisit).toHaveBeenCalledWith(
            "v1",
            "tech-1",
            "org-1",
            expect.anything(),
        );
        vi.mocked(acceptJobVisit).mockClear();
        const bad = await call("post", "/:id/accept", { tech_id: "tech-2" });
        expect(bad.status).toBe(403);
        expect(acceptJobVisit).not.toHaveBeenCalled();
    });

    it("accept maps WRONG_STATE to 409", async () => {
        asDispatcher();
        vi.mocked(acceptJobVisit).mockResolvedValue({
            err: "closed",
            code: "WRONG_STATE",
        } as never);
        const res = await call("post", "/:id/accept", { tech_id: "tech-1" });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("WRONG_STATE");
    });

    it("a dispatcher clock-in without tech_id is 400", async () => {
        asDispatcher();
        const res = await call("post", "/:id/clock-in", {});
        expect(res.status).toBe(400);
        expect(clockInVisit).not.toHaveBeenCalled();
    });
});
