import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
    const $extends = vi.fn();
    const mockDb = {
        client: { findFirst: vi.fn(), update: vi.fn() },
        request: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
        quote: { create: vi.fn(), findUnique: vi.fn() },
        quote_line_item: { createMany: vi.fn() },
        $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
        $extends,
    };
    $extends.mockReturnValue(mockDb);
    return { mockDb };
});

vi.mock("../../db.js", () => ({
    db: mockDb,
    generateQuoteNumber: vi.fn(async () => "Q-0001"),
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
vi.mock("../../services/entitlementService.js", () => ({
    isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
    ...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
    getEffectiveTaxMode: vi.fn(async () => "manual"),
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { insertQuote } from "../quotesController.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const CLIENT = "3f1c2a8e-9b4d-4c6a-8e2f-1a2b3c4d5e6f";
const REQUEST = "7a9e4b21-5c3d-4f8a-9b1e-2c4d6e8f0a1b";

const create = () =>
    insertQuote(
        {
            body: {
                client_id: CLIENT,
                request_id: REQUEST,
                title: "Replace condenser",
                description: "Swap the failed unit",
                address: "1 Main St",
                coords: { lat: 30.2, lon: -97.7 },
            },
        } as unknown as Request,
        "org1",
        { dispatcherId: "d1" },
    );

const withRequestStatus = (status: string, clientId = CLIENT) =>
    mockFn(db.request.findFirst).mockResolvedValue({
        id: REQUEST,
        client_id: clientId,
        status,
        title: "t",
        description: "d",
        address: "1 Main St",
        coords: null,
        priority: "Medium",
    });

describe("insertQuote request status", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFn(db.client.findFirst).mockResolvedValue({ id: CLIENT });
        mockFn(db.quote.create).mockResolvedValue({
            id: "q1",
            quote_number: "Q-0001",
            title: "Replace condenser",
            client_id: CLIENT,
            status: "Draft",
            total: 0,
        });
        mockFn(db.quote.findUnique).mockResolvedValue({ id: "q1" });
        mockFn(db.request.updateMany).mockResolvedValue({ count: 1 });
    });

    it.each(["ConvertedToJob", "Cancelled"])(
        "insertQuote on a %s request is refused and does not write Quoted",
        async (status) => {
            withRequestStatus(status);

            const result = await create();

            expect(result.err).toBe(
                "This request is closed. Reopen it before quoting.",
            );
            expect(db.request.update).not.toHaveBeenCalled();
            expect(db.request.updateMany).not.toHaveBeenCalled();
            expect(db.quote.create).not.toHaveBeenCalled();
        },
    );

    it.each(["Quoted", "QuoteApproved"])(
        "leaves a %s request where it is",
        async (status) => {
            withRequestStatus(status);

            const result = await create();

            expect(result.err).toBe("");
            expect(db.quote.create).toHaveBeenCalled();
            expect(db.request.update).not.toHaveBeenCalled();
            expect(db.request.updateMany).not.toHaveBeenCalled();
        },
    );

    it.each(["New", "Reviewing", "QuoteRejected"])(
        "moves a %s request to Quoted",
        async (status) => {
            withRequestStatus(status);

            const result = await create();

            expect(result.err).toBe("");
            expect(db.request.updateMany).toHaveBeenCalledWith({
                where: {
                    id: REQUEST,
                    status: { in: ["New", "Reviewing", "QuoteRejected"] },
                },
                data: { status: "Quoted" },
            });
        },
    );

    it.each(["ConvertedToJob", "Cancelled"])(
        "a request that turned %s after the read is refused, not overwritten to Quoted",
        async (status) => {
            withRequestStatus("New");
            mockFn(db.request.findFirst).mockResolvedValueOnce({
                id: REQUEST,
                client_id: CLIENT,
                status: "New",
                title: "t",
                description: "d",
                address: "1 Main St",
                coords: null,
                priority: "Medium",
            });
            mockFn(db.request.findFirst).mockResolvedValueOnce({ status });
            mockFn(db.request.updateMany).mockResolvedValue({ count: 0 });

            const result = await create();

            expect(result).toMatchObject({
                err: "This request is closed. Reopen it before quoting.",
                code: "WRONG_STATE",
            });
            expect(db.quote.create).not.toHaveBeenCalled();
        },
    );

    it("a request that moved to Quoted after the read is left alone", async () => {
        withRequestStatus("New");
        mockFn(db.request.findFirst)
            .mockResolvedValueOnce({
                id: REQUEST,
                client_id: CLIENT,
                status: "New",
                title: "t",
                description: "d",
                address: "1 Main St",
                coords: null,
                priority: "Medium",
            })
            .mockResolvedValueOnce({ status: "Quoted" });
        mockFn(db.request.updateMany).mockResolvedValue({ count: 0 });

        const result = await create();

        expect(result.err).toBe("");
        expect(db.quote.create).toHaveBeenCalled();
    });

    it("refuses a request that belongs to another client (400, no refusal code)", async () => {
        withRequestStatus("New", "0b6e7c1d-2f3a-4b5c-8d9e-0f1a2b3c4d5e");

        const result = await create();

        expect(result.err).toBe("This request belongs to a different client.");
        expect("code" in result ? result.code : undefined).toBeUndefined();
        expect(db.request.updateMany).not.toHaveBeenCalled();
        expect(db.quote.create).not.toHaveBeenCalled();
    });

    // Database errors carry internals; they go to the 500 handler, not the caller.
    it("rethrows a database error instead of returning its message", async () => {
        const dbErr = Object.assign(new Error("connection reset by peer at 10.0.0.5"), {
            name: "PrismaClientUnknownRequestError",
        });
        mockFn(db.client.findFirst).mockRejectedValue(dbErr);

        await expect(create()).rejects.toBe(dbErr);
    });
});
