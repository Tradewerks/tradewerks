/**
 * Technician assignment as an add/remove diff: the real route + controller
 * against the fake client, with an in-memory assignment table so a write that
 * blanket-deletes the visit's rows would show up as lost assignments.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/requirePermissions.js", () => ({
    requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
    requireAnyPermission:
        () => (_req: unknown, _res: unknown, next: () => void) =>
            next(),
}));
vi.mock("../../lib/entitlements/requireModule.js", () => ({
    requireModule: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));
vi.mock("../../db.js", async () => ({
    db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/context.js")>()),
    getUserContext: vi.fn(),
}));
vi.mock("../../services/entitlementService.js", () => ({
    isModuleOn: vi.fn(async () => true),
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
    buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
    recomputeVisitTotals: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../controllers/inventoryController.js", () => ({
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
vi.mock("../../controllers/notificationsController.js", () => ({
    createNotification: vi.fn().mockResolvedValue(undefined),
    notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../controllers/visitTimeEntriesController.js", () => ({}));
vi.mock("../../controllers/vehiclesController.js", () => ({}));
vi.mock("../../controllers/visitFieldLinesController.js", () => ({}));

import jobVisitsRouter from "../jobVisits.js";
import { db } from "../../db.js";
import { getUserContext } from "../../lib/context.js";
import { logActivity } from "../../services/logger.js";
import { createNotification } from "../../controllers/notificationsController.js";
import { callRoute, leaves } from "./harness.js";
import { patchVisitTechnicians } from "../../controllers/jobVisitsController.js";

const VISIT = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Fn = ReturnType<typeof vi.fn>;
const fake = db as unknown as Record<string, Record<string, Fn>>;

const techs: Record<string, { id: string; name: string; deactivated_at: Date | null }> = {
    [A]: { id: A, name: "Ana", deactivated_at: null },
    [B]: { id: B, name: "Ben", deactivated_at: null },
    [C]: { id: C, name: "Cy", deactivated_at: null },
    [GONE]: { id: GONE, name: "Gone", deactivated_at: new Date("2026-01-01") },
};

let status = "Scheduled";
let assigned: Map<string, string>;
let openEntries: string[];

const idsIn = (where: unknown, key: string): string[] | undefined => {
    const leaf = leaves(where).find((l) => key in l);
    const v = leaf?.[key] as { in?: string[] } | string | undefined;
    if (v === undefined) return undefined;
    return typeof v === "string" ? [v] : v.in;
};

const rows = () =>
    [...assigned.entries()].map(([tech_id, tech_status]) => ({
        visit_id: VISIT,
        tech_id,
        tech_status,
        tech: techs[tech_id],
    }));

const asDispatcher = () =>
    vi.mocked(getUserContext).mockReturnValue({ dispatcherId: "disp-1" });

const patch = (body: unknown) =>
    callRoute(jobVisitsRouter, "patch", "/:id/technicians", {
        params: { id: VISIT },
        body,
    });
const put = (tech_ids: string[]) =>
    callRoute(jobVisitsRouter, "put", "/:id/technicians", {
        params: { id: VISIT },
        body: { tech_ids },
    });

beforeEach(() => {
    vi.clearAllMocks();
    asDispatcher();
    status = "Scheduled";
    assigned = new Map([[A, "OnSite"]]);
    openEntries = [];

    fake.job_visit.findFirst.mockReset().mockImplementation(async () => ({
        id: VISIT,
        job_id: "job-1",
        status,
        scheduled_start_at: new Date("2026-11-18T15:00:00Z"),
        job: { job_number: "J-1", client: { name: "Client" } },
        visit_techs: rows(),
        notes: [],
    }));
    fake.job_visit_technician.findMany.mockReset().mockImplementation(async () => rows());
    // The in-tx row locks; only the visit lock's status is read back.
    (db as unknown as { $queryRaw: Fn }).$queryRaw.mockReset().mockImplementation(async () => [{ status }]);
    fake.technician.findMany.mockReset().mockImplementation(async (args: { where: unknown }) =>
        (idsIn(args.where, "id") ?? []).filter((id) => techs[id]).map((id) => techs[id]),
    );
    fake.visit_tech_time_entry.findFirst
        .mockReset()
        .mockImplementation(async (args: { where: unknown }) => {
            const ids = idsIn(args.where, "tech_id") ?? [];
            const hit = openEntries.find((id) => ids.includes(id));
            return hit ? { tech: { name: techs[hit].name } } : null;
        });
    fake.job_visit_technician.deleteMany
        .mockReset()
        .mockImplementation(async (args: { where: unknown }) => {
            const ids = idsIn(args.where, "tech_id");
            let count = 0;
            for (const id of ids ?? [...assigned.keys()]) {
                if (assigned.delete(id)) count++;
            }
            return { count };
        });
    fake.job_visit_technician.createMany
        .mockReset()
        .mockImplementation(async (args: { data: { tech_id: string }[] }) => {
            for (const r of args.data) {
                if (!assigned.has(r.tech_id)) assigned.set(r.tech_id, "Assigned");
            }
            return { count: args.data.length };
        });
});

describe("PATCH /job-visits/:id/technicians", () => {
    it("two dispatchers adding different techs to the same visit both land", async () => {
        const [first, second] = await Promise.all([patch({ add: [B] }), patch({ add: [C] })]);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect([...assigned.keys()].sort()).toEqual([A, B, C].sort());
        expect(assigned.get(A)).toBe("OnSite");
    });

    it("removing a tech that is not assigned is a no-op, not an error", async () => {
        const res = await patch({ remove: [B] });
        expect(res.status).toBe(200);
        expect([...assigned.keys()]).toEqual([A]);
        expect(fake.job_visit_technician.deleteMany).not.toHaveBeenCalled();
        expect(logActivity).not.toHaveBeenCalled();
    });

    it("removing the last tech from an InProgress visit returns 400", async () => {
        status = "InProgress";
        const res = await patch({ remove: [A] });
        expect(res.status).toBe(400);
        expect(assigned.has(A)).toBe(true);
    });

    it("an id in both add and remove returns 400", async () => {
        const res = await patch({ add: [B], remove: [B] });
        expect(res.status).toBe(400);
        expect(fake.job_visit_technician.createMany).not.toHaveBeenCalled();
    });

    it("adding a deactivated tech returns 400", async () => {
        const res = await patch({ add: [GONE] });
        expect(res.status).toBe(400);
        expect(assigned.has(GONE)).toBe(false);
    });

    it("rejects non-uuid ids and more than 20 per list", async () => {
        expect((await patch({ add: ["nope"] })).status).toBe(400);
        const many = Array.from(
            { length: 21 },
            (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        );
        expect((await patch({ add: many })).status).toBe(400);
    });

    it("removing a clocked-in tech is 409 WRONG_STATE", async () => {
        assigned.set(B, "OnSite");
        openEntries = [B];
        const res = await patch({ remove: [B] });
        expect(res.status).toBe(409);
        expect(res.body.error).toEqual(
            expect.objectContaining({
                code: "WRONG_STATE",
                message: "Ben is clocked in on this visit. Clock them out first.",
            }),
        );
        expect(assigned.has(B)).toBe(true);
    });

    it("logs one technicians change with old and new names", async () => {
        const res = await patch({ add: [B] });
        expect(res.status).toBe(200);
        expect(logActivity).toHaveBeenCalledTimes(1);
        const entry = vi.mocked(logActivity).mock.calls[0][0] as {
            changes: { technicians: { old: string[]; new: string[] } };
        };
        expect(entry.changes.technicians.old).toEqual(["Ana"]);
        expect(entry.changes.technicians.new.sort()).toEqual(["Ana", "Ben"]);
    });

    it("an add that another writer already landed is a no-op under the lock", async () => {
        const stale = await fake.job_visit.findFirst();
        fake.job_visit.findFirst.mockResolvedValueOnce(stale);
        assigned.set(B, "Assigned");
        const res = await patch({ add: [B] });
        expect(res.status).toBe(200);
        expect(fake.job_visit_technician.createMany).not.toHaveBeenCalled();
        expect(logActivity).not.toHaveBeenCalled();
        expect(createNotification).not.toHaveBeenCalled();
    });

    it("decides the diff from the locked read, not the stale pre-read", async () => {
        assigned.set(B, "Assigned");
        const stale = await fake.job_visit.findFirst();
        fake.job_visit.findFirst.mockResolvedValueOnce(stale);
        assigned.delete(B);
        const res = await patch({ add: [B] });
        expect(res.status).toBe(200);
        expect(assigned.get(B)).toBe("Assigned");
        expect(createNotification).toHaveBeenCalledTimes(1);
    });

    it("re-checks the resulting set under the lock: a concurrent removal makes this one the last", async () => {
        status = "InProgress";
        assigned.set(B, "OnSite");
        const stale = await fake.job_visit.findFirst();
        fake.job_visit.findFirst.mockResolvedValueOnce(stale);
        assigned.delete(B);
        const res = await patch({ remove: [A] });
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe(
            "Can't remove every technician while the visit is InProgress. Assign someone else first.",
        );
        expect(assigned.has(A)).toBe(true);
        expect(fake.job_visit_technician.deleteMany).not.toHaveBeenCalled();
    });

    it("is 403 for a technician caller", async () => {
        vi.mocked(getUserContext).mockReturnValue({ techId: A });
        const res = await patch({ add: [B] });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("FORBIDDEN");
        expect(fake.job_visit_technician.createMany).not.toHaveBeenCalled();
    });

    it("an unknown visit is 404", async () => {
        fake.job_visit.findFirst.mockResolvedValue(null);
        const res = await patch({ add: [B] });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
    });
});

describe("legacy PUT /job-visits/:id/technicians runs through the diff", () => {
    it("adding to the full list keeps the existing row and its tech_status", async () => {
        const res = await put([A, B]);
        expect(res.status).toBe(200);
        expect(assigned.get(A)).toBe("OnSite");
        expect(assigned.get(B)).toBe("Assigned");
        expect(fake.job_visit_technician.deleteMany).not.toHaveBeenCalled();
    });

    it("dropping one tech deletes only that row", async () => {
        assigned.set(B, "OnSite");
        const res = await put([B]);
        expect(res.status).toBe(200);
        expect([...assigned.keys()]).toEqual([B]);
        expect(idsIn(fake.job_visit_technician.deleteMany.mock.calls[0][0].where, "tech_id")).toEqual([A]);
    });

    it("refuses dropping a clocked-in tech with 409 WRONG_STATE", async () => {
        openEntries = [A];
        const res = await put([]);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("WRONG_STATE");
        expect(assigned.has(A)).toBe(true);
    });

    it("validates tech_ids like PATCH: uuids only, at most 20, and required", async () => {
        expect((await put(["nope"])).status).toBe(400);
        const many = Array.from(
            { length: 21 },
            (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        );
        expect((await put(many)).status).toBe(400);
        const missing = await callRoute(jobVisitsRouter, "put", "/:id/technicians", {
            params: { id: VISIT },
            body: {},
        });
        expect(missing.status).toBe(400);
        expect(missing.body.error.message).toBe("tech_ids must be an array");
        expect(fake.job_visit_technician.deleteMany).not.toHaveBeenCalled();
        expect(fake.job_visit_technician.createMany).not.toHaveBeenCalled();
    });

    it("is 403 for a technician caller", async () => {
        vi.mocked(getUserContext).mockReturnValue({ techId: A });
        const res = await put([A, B]);
        expect(res.status).toBe(403);
        expect(fake.job_visit_technician.createMany).not.toHaveBeenCalled();
    });
});

describe("patchVisitTechnicians called directly (the assistant's path)", () => {
    it("refuses a technician context with FORBIDDEN before reading anything", async () => {
        const res = await patchVisitTechnicians(VISIT, { add: [B], remove: [] }, "org-1", { techId: A });
        expect(res).toEqual(expect.objectContaining({ code: "FORBIDDEN" }));
        expect(fake.job_visit.findFirst).not.toHaveBeenCalled();
    });
});
