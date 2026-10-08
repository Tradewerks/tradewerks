import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LimitsCard from "../components/LimitsCard";
import type { OrgDetail } from "../types";

const detail = (overrides: Record<string, number | null> = {}): OrgDetail => ({
	org: { id: "org-1", name: "Acme" },
	entitlement: {
		plan_version_id: "pv-2",
		plan_source: "operator",
		template_key: "hvac",
		trial_plan_version_id: null,
		trial_ends_at: null,
		module_choices: {},
		module_grants: {},
		limit_overrides: overrides,
		updated_at: "2026-10-07T00:00:00Z",
	},
	resolved: { planKey: "pro", planVersion: 2, trialActive: false, modules: {}, limits: {} },
	usage: null,
	catalog: [],
	breakdown: {
		modules: {},
		limits: {
			dispatchers:
				"dispatchers" in overrides
					? {
							tier: 5,
							override: overrides.dispatchers,
							effective: overrides.dispatchers,
						}
					: { tier: 5, effective: 5 },
			technicians: { tier: null, effective: null },
			ai_calls_month: { tier: 100, effective: 100 },
			tax_lookups_month: { tier: 50, effective: 50 },
			receipt_scans_month: { tier: 300, effective: 300 },
		},
		baseTier: { key: "pro", label: "Pro", version: 2 },
		trialTier: null,
	},
});
const row = () => within(screen.getByText("Dispatchers").closest("li")!);
const edit = () => fireEvent.click(row().getByRole("button", { name: "Edit" }));
const review = () => row().getByRole("button", { name: "Review change" });

describe("LimitsCard", () => {
	it("shows effective value and tier source", () => {
		render(<LimitsCard detail={detail()} open={vi.fn()} changed={new Set()} />);
		expect(row().getByText("Effective 5")).toBeInTheDocument();
		expect(row().getByText("Tier 5")).toBeInTheDocument();
	});

	it("only Custom mode shows a number input", () => {
		render(<LimitsCard detail={detail()} open={vi.fn()} changed={new Set()} />);
		edit();
		expect(row().queryByRole("spinbutton")).toBeNull();
		fireEvent.click(row().getByRole("button", { name: "Unlimited" }));
		expect(row().queryByRole("spinbutton")).toBeNull();
		fireEvent.click(row().getByRole("button", { name: "Custom" }));
		expect(row().getByRole("spinbutton")).toHaveValue(5);
	});

	it("Review is disabled while nothing would change", () => {
		render(<LimitsCard detail={detail()} open={vi.fn()} changed={new Set()} />);
		edit();
		expect(review()).toBeDisabled();
	});

	it("custom 0 is allowed; negative and decimal are not", () => {
		const open = vi.fn();
		render(<LimitsCard detail={detail()} open={open} changed={new Set()} />);
		edit();
		fireEvent.click(row().getByRole("button", { name: "Custom" }));
		const input = row().getByRole("spinbutton");
		fireEvent.change(input, { target: { value: "-1" } });
		expect(review()).toBeDisabled();
		fireEvent.change(input, { target: { value: "1.5" } });
		expect(review()).toBeDisabled();
		fireEvent.change(input, { target: { value: "0" } });
		fireEvent.click(review());
		expect(open).toHaveBeenCalledWith({
			change: { kind: "limit", key: "dispatchers", override: 0 },
			title: "Dispatchers: set to 0",
		});
	});

	it("an existing override can go back to the tier value", () => {
		const open = vi.fn();
		render(
			<LimitsCard
				detail={detail({ dispatchers: 8 })}
				open={open}
				changed={new Set()}
			/>
		);
		expect(row().getByText("Override 8 · tier 5")).toBeInTheDocument();
		edit();
		fireEvent.click(row().getByRole("button", { name: "Tier value" }));
		fireEvent.click(review());
		expect(open).toHaveBeenCalledWith({
			change: { kind: "limit", key: "dispatchers", override: "tier" },
			title: "Dispatchers: use tier value (5)",
		});
	});
});
