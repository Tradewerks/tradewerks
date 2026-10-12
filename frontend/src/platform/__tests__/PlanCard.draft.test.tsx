import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PlanCard from "../components/PlanCard";
import type { PlanDraft } from "../usePlanDraft";
import type { StaffChangesPreview, TierRow } from "../types";
import { detail, draftOf, tiers } from "./planFixtures";

const withMax: TierRow[] = [
	...tiers,
	{
		...tiers[0],
		key: "max",
		label: "Max",
		versions: [{ ...tiers[0].versions[0], id: "pv-m1", version: 1 }],
	},
];

const projected = (over: Partial<StaffChangesPreview> = {}): StaffChangesPreview => ({
	before: {} as never,
	after: {} as never,
	diff: { lost: [], gained: ["inventory"], lowered: [], raised: [] },
	blockers: [],
	overCap: [],
	breakdown: {
		modules: {
			quickbooks: { state: "not_in_plan", source: "grant_off" },
			inventory: { state: "on", source: "tier" },
			purchasing: { state: "off_by_org", source: "org_off" },
		},
		limits: {} as never,
		baseTier: { key: "max", label: "Max", version: 1 },
		trialTier: null,
	},
	...over,
});

const drafting = (over: Partial<PlanDraft> = {}) =>
	draftOf({
		state: { planVersionId: "pv-m1", grants: {}, stamp: "t" },
		changes: [{ kind: "plan", planVersionId: "pv-m1" }],
		preview: projected(),
		...over,
	});

const row = (name: string) => screen.getByText(name).closest("li")!;
const renderCard = (draft: PlanDraft, open = vi.fn()) =>
	render(
		<PlanCard
			detail={detail()}
			tiers={withMax}
			open={open}
			changed={new Set()}
			draft={draft}
			draftBar={draft.state ? <p>draft bar</p> : null}
		/>
	);

describe("PlanCard draft mode", () => {
	it("a tier pick edits the draft and opens no dialog", () => {
		const open = vi.fn();
		const draft = draftOf();
		renderCard(draft, open);
		fireEvent.change(screen.getByLabelText("New tier"), { target: { value: "pv-m1" } });
		expect(draft.setTier).toHaveBeenCalledWith("pv-m1");
		expect(open).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Review change" })).toBeNull();
	});

	it("the select shows the draft's target tier", () => {
		renderCard(drafting());
		expect(screen.getByLabelText("New tier")).toHaveValue("pv-m1");
	});

	it("shows current → projected only on rows that move, and marks them", () => {
		renderCard(drafting());
		const inv = within(row("Inventory"));
		expect(inv.getByText("→")).toBeInTheDocument();
		expect(inv.getByText("Included in Max")).toBeInTheDocument();
		expect(row("Inventory").className).toContain("border-primary");
		expect(within(row("QuickBooks")).queryByText("→")).toBeNull();
		expect(row("QuickBooks").className).not.toContain("border-primary");
	});

	it("an Off that stays Off shows no arrow but keeps the row marked", () => {
		renderCard(drafting());
		const purchasing = row("Purchasing");
		expect(within(purchasing).queryByText("→")).toBeNull();
		expect(within(purchasing).getAllByText("Off")).toHaveLength(1);
		expect(purchasing.className).toContain("border-primary");
	});

	it("a toggle edits the draft, reflects the draft grant and marks the row", () => {
		const open = vi.fn();
		const draft = drafting({
			state: { planVersionId: null, grants: { quickbooks: null }, stamp: "t" },
		});
		renderCard(draft, open);
		const group = screen.getByRole("group", { name: "QuickBooks override" });
		expect(within(group).getByRole("button", { name: "Tier default" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(row("QuickBooks").className).toContain("border-primary");
		fireEvent.click(within(group).getByRole("button", { name: "Force on" }));
		expect(draft.setGrant).toHaveBeenCalledWith("quickbooks", "on");
		expect(open).not.toHaveBeenCalled();
	});

	it("without a draft the card shows the stored state and no bar", () => {
		renderCard(draftOf());
		expect(within(row("Inventory")).queryByText("→")).toBeNull();
		expect(screen.queryByText("draft bar")).toBeNull();
		expect(screen.getByLabelText("New tier")).toHaveValue("");
	});

	it("keeps the current list while the first preview loads", () => {
		renderCard(drafting({ preview: undefined, previewPending: true }));
		expect(screen.getByText("Updating preview…")).toBeInTheDocument();
		expect(within(row("Inventory")).getByText("Not in Pro")).toBeInTheDocument();
		expect(screen.getByText("draft bar")).toBeInTheDocument();
	});

	it("shows a blocker under the affected row", () => {
		renderCard(
			drafting({
				preview: projected({
					diff: {
						lost: ["quickbooks"],
						gained: [],
						lowered: [],
						raised: [],
					},
					blockers: [
						{
							module: "quickbooks",
							label: "QuickBooks",
							count: 2,
							message: "2 invoices are still syncing",
						},
					],
				}),
			})
		);
		expect(
			within(row("QuickBooks")).getByText("2 invoices are still syncing")
		).toBeInTheDocument();
	});
});
