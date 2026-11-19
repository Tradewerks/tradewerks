import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { hideCostFromTechnicians } from "../requirePermissions.js";

const body = {
	data: [{ id: "a", cost: 12.5, unit_price: 30, inventory_item: { cost: 4, name: "Filter" } }],
	error: null,
};

const send = (role: string) => {
	const sent = vi.fn();
	const res = { json: sent } as unknown as Response;
	hideCostFromTechnicians({ user: { role } } as unknown as Request, res, vi.fn());
	res.json(body);
	return sent.mock.calls[0][0];
};

describe("hideCostFromTechnicians", () => {
	it("drops every cost from a technician's response, nested ones too", () => {
		expect(send("technician")).toEqual({
			data: [{ id: "a", unit_price: 30, inventory_item: { name: "Filter" } }],
			error: null,
		});
	});

	it("leaves a dispatcher's response alone", () => {
		expect(send("dispatcher")).toBe(body);
	});
});
