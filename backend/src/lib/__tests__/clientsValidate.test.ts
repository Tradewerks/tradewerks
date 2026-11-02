import { describe, expect, it } from "vitest";
import { updateClientSchema } from "../validate/clients.js";

describe("updateClientSchema", () => {
	it("accepts an update that only changes is_tax_exempt", () => {
		expect(updateClientSchema.parse({ is_tax_exempt: true })).toEqual({ is_tax_exempt: true });
	});

	it("still rejects an empty update", () => {
		expect(() => updateClientSchema.parse({})).toThrow();
	});
});
