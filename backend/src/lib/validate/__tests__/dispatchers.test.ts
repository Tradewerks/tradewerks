import { describe, it, expect } from "vitest";
import { updateDispatcherSchema } from "../dispatchers.js";

describe("updateDispatcherSchema", () => {
	it("strips role and organization_id so a self-update can't escalate", () => {
		const parsed = updateDispatcherSchema.parse({
			name: "Sam",
			role: "admin",
			organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		});
		expect(parsed).toEqual({ name: "Sam" });
	});

	it("rejects a body with only role", () => {
		expect(updateDispatcherSchema.safeParse({ role: "admin" }).success).toBe(false);
	});
});
