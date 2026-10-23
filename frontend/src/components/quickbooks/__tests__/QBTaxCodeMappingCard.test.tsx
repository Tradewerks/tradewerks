import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QBTaxCodeMappingCard from "../QBTaxCodeMappingCard";

const mocks = vi.hoisted(() => ({
	auto: true as boolean | undefined,
	setPassthrough: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
}));

vi.mock("../../../hooks/useTaxGroups", () => ({ useTaxGroups: () => ({ data: [] }) }));
vi.mock("../../../hooks/useAutoTaxMode", () => ({ useAutoTaxMode: () => mocks.auto }));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBTaxCodesQuery: () => ({ data: [] }),
	useQBTaxPrefsQuery: () => ({ data: { automatedSalesTax: false, passthroughTaxCodeId: null } }),
	useLinkTaxCodeMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useUnlinkTaxCodeMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useSetPassthroughTaxCodeMutation: () => mocks.setPassthrough,
}));

const conflict = Object.assign(new Error("Request failed with status code 409"), {
	isAxiosError: true,
	response: {
		status: 409,
		data: {
			error: {
				code: "CONFLICT",
				message: "Turn off automated tax before removing the pass-through tax code.",
			},
		},
	},
});

describe("QBTaxCodeMappingCard", () => {
	beforeEach(() => {
		mocks.auto = true;
		mocks.setPassthrough = { mutate: vi.fn(), isPending: false, isError: true, error: conflict };
	});

	it("shows the server's conflict message", () => {
		render(<QBTaxCodeMappingCard />);
		expect(
			screen.getByText("Turn off automated tax before removing the pass-through tax code."),
		).toBeTruthy();
	});

	it("uses pass-through wording and the override note in auto mode", () => {
		render(<QBTaxCodeMappingCard />);
		expect(screen.getByText("Pass-through tax code (required for automatic tax)")).toBeTruthy();
		expect(screen.getByText("Used only for lines with an override tax group.")).toBeTruthy();
	});

	it("keeps the combined label and no note in manual mode", () => {
		mocks.auto = false;
		render(<QBTaxCodeMappingCard />);
		expect(screen.getByText("Combined tax code")).toBeTruthy();
		expect(screen.queryByText("Used only for lines with an override tax group.")).toBeNull();
	});

	it("falls back to the generic message when the error carries none", () => {
		mocks.setPassthrough = { ...mocks.setPassthrough, error: new Error("") };
		render(<QBTaxCodeMappingCard />);
		expect(screen.getByText("Couldn't save the combined tax code.")).toBeTruthy();
	});
});
