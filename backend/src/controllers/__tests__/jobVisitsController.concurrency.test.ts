/**
 * Two dispatchers editing the same visit: the second save carries the
 * updated_at it loaded, finds the row has moved on, and is refused whole.
 * Runs the real route + controller against the fake client so the 409
 * envelope and the scoped updateMany are both exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/requirePermissions.js", () => ({
    requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
    requireAnyPermission:
        () => (_req: unknown, _res: unknown, next: () => void) =>
            next(),
    hasPermission: () => true,
}));
vi.mock("../../lib/requireAssigned.js", () => ({
    requireAssigned: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));
vi.mock("../../lib/entitlements/requireModule.js", () => ({
    requireModule: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));
vi.mock("../../db.js", async () => ({
    db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));
vi.mock("../../services/customerComms/visitEvents.js", () => ({
    notifyVisitScheduled: vi.fn(async () => undefined),
    notifyVisitRescheduled: vi.fn(async () => undefined),
    notifyVisitCancelled: vi.fn(async () => undefined),
    retimeVisitReminders: vi.fn(async () => undefined),
    notifyJobCompleted: vi.fn(async () => undefined),
    notifyVisitCompleted: vi.fn(async () => undefined),
    notifyTechOnTheWay: vi.fn(async () => undefined),
}));
vi.mock("../../services/logger.js", () => ({
    logActivity: vi.fn().mockResolvedValue(undefined),
    buildChanges: vi.fn().mockReturnValue({ name: { old: "a", new: "b" } }),
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
    recomputeVisitTotals: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../inventoryController.js", () => ({
    deductInventoryForVisit: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
}));
vi.mock("../../services/lowStockAlerts.js", () => ({
    fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/followupTriggers.js", () => ({
    onVisitScheduled: vi.fn(),
    onVisitRescheduled: vi.fn(),
    onVisitCancelled: vi.fn(),
}));
vi.mock("../../services/socketService.js", () => ({
    getSocket: vi.fn().mockReturnValue(null),
    emitToOrg: vi.fn(),
}));
vi.mock("../notificationsController.js", () => ({
    createNotification: vi.fn().mockResolvedValue(undefined),
    notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../visitTimeEntriesController.js", () => ({}));
vi.mock("../vehiclesController.js", () => ({}));
vi.mock("../visitFieldLinesController.js", () => ({}));

import jobVisitsRouter from "../../routes/jobVisits.js";
import { db } from "../../db.js";
import { logActivity } from "../../services/logger.js";
import { callRoute, leaves } from "../../routes/__tests__/harness.js";

const T0 = "2026-11-18T10:00:00.000Z";
const T1 = "2026-11-18T10:05:00.000Z";
const T2 = "2026-11-18T10:06:00.000Z";
const LINE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const fake = db as unknown as {
    job_visit: Record<string, ReturnType<typeof vi.fn>>;
    job_visit_line_item: Record<string, ReturnType<typeof vi.fn>>;
};

let currentUpdatedAt = T0;

beforeEach(() => {
    vi.clearAllMocks();
    currentUpdatedAt = T0;
    fake.job_visit.findFirst.mockReset().mockImplementation(
        async (args: { select?: { updated_at?: boolean } }) => {
            if (args?.select?.updated_at) {
                return { updated_at: new Date(currentUpdatedAt) };
            }
            return {
                id: "v1",
                job_id: "job-1",
                name: "Visit 1",
                status: "Scheduled",
                scheduled_start_at: new Date("2026-11-20T15:00:00.000Z"),
                updated_at: new Date(currentUpdatedAt),
                line_items: [
                    {
                        id: LINE_ID,
                        fulfillment_status: "planned",
                        inventory_item_id: null,
                    },
                ],
                visit_techs: [],
                notes: [],
                job: {
                    id: "job-1",
                    status: "Scheduled",
                    job_number: "J-1",
                    recurring_plan_id: null,
                    client: { name: "Acme" },
                },
            };
        },
    );
    fake.job_visit.update.mockReset().mockImplementation(async () => {
        currentUpdatedAt = T1;
        return { id: "v1" };
    });
    fake.job_visit.updateMany.mockReset().mockImplementation(
        async (args: { where: unknown }) => {
            const wanted = leaves(args.where).find((l) => "updated_at" in l);
            const matches =
                (wanted?.updated_at as Date | undefined)?.getTime() ===
                new Date(currentUpdatedAt).getTime();
            if (!matches) return { count: 0 };
            currentUpdatedAt = T1;
            return { count: 1 };
        },
    );
});

const put = (body: Record<string, unknown>) =>
    callRoute(jobVisitsRouter, "put", "/:id", { params: { id: "v1" }, body });

describe("PUT /job-visits/:id optimistic concurrency", () => {
    it("PUT with a matching expected_updated_at saves and returns the new updated_at", async () => {
        const res = await put({ name: "Renamed", expected_updated_at: T0 });

        expect(res.status).toBe(200);
        expect(res.body.data.updated_at).toEqual(new Date(T1));
        const where = fake.job_visit.updateMany.mock.calls[0][0].where;
        expect(leaves(where)).toContainEqual({ updated_at: new Date(T0) });
        expect(leaves(where)).toContainEqual({ id: "v1" });
    });

    it("PUT with a stale expected_updated_at returns 409 CONFLICT and writes nothing (line items untouched)", async () => {
        currentUpdatedAt = T2;
        const res = await put({
            name: "Renamed",
            expected_updated_at: T0,
            line_items: [
                {
                    name: "New part",
                    quantity: 1,
                    unit_price: 10,
                    item_type: "material",
                },
            ],
        });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            success: false,
            data: { current_updated_at: T2 },
            error: expect.objectContaining({
                code: "CONFLICT",
                message: "This visit was changed by someone else.",
            }),
            meta: expect.anything(),
        });
        expect(fake.job_visit_line_item.delete).not.toHaveBeenCalled();
        expect(fake.job_visit_line_item.update).not.toHaveBeenCalled();
        expect(fake.job_visit_line_item.create).not.toHaveBeenCalled();
        expect(fake.job_visit.update).not.toHaveBeenCalled();
        expect(logActivity).not.toHaveBeenCalled();
    });

    it("PUT without expected_updated_at still saves (agent/MCP callers)", async () => {
        const res = await put({ name: "Renamed" });

        expect(res.status).toBe(200);
        expect(fake.job_visit.updateMany).not.toHaveBeenCalled();
        expect(fake.job_visit.update).toHaveBeenCalledTimes(1);
    });

    it("concurrent PUTs with the same expected_updated_at: one 200, one 409", async () => {
        const [a, b] = await Promise.all([
            put({ name: "From A", expected_updated_at: T0 }),
            put({ name: "From B", expected_updated_at: T0 }),
        ]);

        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect(fake.job_visit.updateMany).toHaveBeenCalledTimes(2);
    });

    it("rejects an expected_updated_at that is not an ISO datetime", async () => {
        const res = await put({ name: "Renamed", expected_updated_at: "yesterday" });

        expect(res.status).toBe(400);
        expect(fake.job_visit.updateMany).not.toHaveBeenCalled();
        expect(fake.job_visit.update).not.toHaveBeenCalled();
    });
});
