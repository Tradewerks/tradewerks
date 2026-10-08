import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequestBanner from "../components/RequestBanner";
import type { TierRow, UpgradeRequest } from "../types";

const tiers = [
	{
		key: "pro",
		label: "Pro",
		assignable: true,
		archived_at: null,
		is_signup_default: false,
		is_trial_default: false,
		versions: [
			{
				id: "pv-3",
				version: 3,
				modules: [],
				limits: {},
				note: null,
				created_at: "",
				org_count: 0,
				trial_org_count: 0,
			},
		],
	},
] as TierRow[];
const request = {
	id: "r1",
	organization_id: "org-1",
	org_name: "Acme",
	requested_by_id: "d-1",
	requested_by_name: "Dana",
	requested_plan_key: "pro",
	requested_plan_label: "Pro",
	requested_modules: [{ key: "quickbooks", label: "QuickBooks" }],
	note: "Growing fast",
	status: "open",
	resolution_note: null,
	resolved_at: null,
	created_at: "2026-10-07T00:00:00Z",
} as UpgradeRequest;

describe("RequestBanner", () => {
	it("offers one Apply per part and opens the dialog for it", () => {
		const onApply = vi.fn();
		render(
			<RequestBanner
				request={request}
				tiers={tiers}
				onApply={onApply}
				onResolve={vi.fn()}
			/>
		);
		expect(screen.getByText("Growing fast")).toBeInTheDocument();
		const buttons = screen.getAllByRole("button", { name: /Apply/ });
		expect(buttons).toHaveLength(2);
		fireEvent.click(buttons[1]);
		expect(onApply).toHaveBeenCalledWith({
			change: { kind: "grant", module: "quickbooks", grant: "on" },
			title: "Force on QuickBooks",
		});
	});

	it("note-only requests offer no Apply, only close actions", () => {
		const onResolve = vi.fn();
		render(
			<RequestBanner
				request={{
					...request,
					requested_plan_key: null,
					requested_plan_label: null,
					requested_modules: [],
					note: "Need 3 seats",
				}}
				tiers={tiers}
				onApply={vi.fn()}
				onResolve={onResolve}
			/>
		);
		expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Decline" }));
		expect(onResolve).toHaveBeenCalledWith("declined");
	});
});
