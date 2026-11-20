import { describe, it, expect, vi } from "vitest";

vi.mock("../../../services/wasabiService.js", () => ({
    isOwnBucketUrl: vi.fn(() => true),
}));

import { createJobSchema, updateJobSchema } from "../jobs.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";

describe("updateJobSchema", () => {
    it.each([
        { status: "Completed" },
        { actual_total: 10 },
        { cancellation_reason: "no longer needed" },
    ])("rejects %o and names the cancel endpoint", (body) => {
        const res = updateJobSchema.safeParse(body);
        expect(res.success).toBe(false);
        expect(res.error?.issues[0]?.message).toContain(
            "POST /jobs/:id/cancel",
        );
    });

    it("still accepts an ordinary edit", () => {
        expect(updateJobSchema.safeParse({ name: "New name" }).success).toBe(
            true,
        );
    });
});

describe("createJobSchema", () => {
    it("rejects a non-Unscheduled status", () => {
        const res = createJobSchema.safeParse({
            client_id: CLIENT,
            status: "Completed",
        });
        expect(res.success).toBe(false);
    });

    it("accepts Unscheduled or no status", () => {
        expect(
            createJobSchema.safeParse({
                client_id: CLIENT,
                status: "Unscheduled",
            }).success,
        ).toBe(true);
        expect(createJobSchema.safeParse({ client_id: CLIENT }).success).toBe(
            true,
        );
    });
});
