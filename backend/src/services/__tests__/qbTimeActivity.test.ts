import { describe, it, expect, vi } from "vitest";

vi.mock("../quickbooksService.js", () => ({ qbFetch: vi.fn(), getOrgRealmId: vi.fn() }));
vi.mock("../../db.js", () => ({ db: {} }));

import { isQBNotFound } from "../qb/qbTimeActivity.js";

const qbErr = (status: number, code: string) =>
	new Error(
		`QB GET /timeactivity/1 → ${status}: {"Fault":{"Error":[{"Message":"Object Not Found","code":"${code}"}],"type":"ValidationFault"}}`,
	);

describe("isQBNotFound", () => {
	it("matches QB's object-not-found fault", () => {
		expect(isQBNotFound(qbErr(400, "610"))).toBe(true);
	});

	it("ignores other QB errors and non-errors", () => {
		expect(isQBNotFound(qbErr(400, "5010"))).toBe(false);
		expect(isQBNotFound(new Error("QB GET /timeactivity/1 → 401: Unauthorized"))).toBe(false);
		expect(isQBNotFound("610")).toBe(false);
	});
});
