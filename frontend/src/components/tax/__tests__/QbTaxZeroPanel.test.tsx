import { describe, it, expect, vi } from "vitest";
import { renderHook, act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError, type AxiosResponse } from "axios";
import QbTaxZeroPanel from "../QbTaxZeroPanel";
import { useQbTaxZero } from "../useQbTaxZero";

const zeroError = (code = "QB_TAX_ZERO") =>
	new AxiosError("409", "ERR_BAD_REQUEST", undefined, undefined, {
		status: 409,
		data: {
			error: { code, details: { items: ["Copper pipe", "Filter"], line_ids: ["l1", "l2"] } },
		},
	} as AxiosResponse);

describe("QbTaxZeroPanel", () => {
	it("names the QuickBooks items and says to set the sales tax category there", () => {
		render(<QbTaxZeroPanel zero={{ items: ["Copper pipe", "Filter"], line_ids: [] }} onClose={vi.fn()} />);
		expect(screen.getByText(/QuickBooks charged no tax/)).toBeInTheDocument();
		expect(screen.getByText(/Copper pipe, Filter/)).toBeInTheDocument();
		expect(screen.getByText(/set the sales tax category in QuickBooks/i)).toBeInTheDocument();
	});

	it("closes", async () => {
		const onClose = vi.fn();
		render(<QbTaxZeroPanel zero={{ items: ["A"], line_ids: [] }} onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});
});

describe("useQbTaxZero", () => {
	it("captures a QB_TAX_ZERO refusal and reports it handled", () => {
		const { result } = renderHook(() => useQbTaxZero());
		expect(result.current.qbZero).toBeNull();
		let handled = false;
		act(() => {
			handled = result.current.handleError(zeroError());
		});
		expect(handled).toBe(true);
		expect(result.current.qbZero).toEqual({
			items: ["Copper pipe", "Filter"],
			line_ids: ["l1", "l2"],
		});
		act(() => result.current.clear());
		expect(result.current.qbZero).toBeNull();
	});

	it("ignores other errors", () => {
		const { result } = renderHook(() => useQbTaxZero());
		let handled = true;
		act(() => {
			handled = result.current.handleError(zeroError("OTHER"));
		});
		expect(handled).toBe(false);
		expect(result.current.qbZero).toBeNull();
	});
});
