import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import { sendResultErr } from "../../types/responses.js";

const fakeRes = () => {
	const res = { status: vi.fn(), json: vi.fn() };
	res.status.mockReturnValue(res);
	return res as unknown as Response & typeof res;
};

describe("sendResultErr", () => {
	it("sends a missing record as 404 NOT_FOUND whatever the route's status", () => {
		const res = fakeRes();
		sendResultErr(res, "Job visit not found", 409);
		expect(res.status).toHaveBeenCalledWith(404);
		expect(res.json.mock.calls[0][0].error.code).toBe("NOT_FOUND");
	});

	it("keeps the route's status and code for anything else", () => {
		const res = fakeRes();
		sendResultErr(res, "Technicians not found or deactivated: t1", 400, "DELETE_ERROR");
		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json.mock.calls[0][0].error.code).toBe("DELETE_ERROR");
	});
});
