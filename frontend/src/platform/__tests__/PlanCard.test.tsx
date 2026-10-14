import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PlanCard from "../components/PlanCard";
import type { OrgDetail } from "../types";
import { detail, draftOf, tiers } from "./planFixtures";

const row = (name: string) => screen.getByText(name).closest("li")!;
const renderCard = (d: OrgDetail, changed = new Set<string>()) =>
	render(
		<PlanCard
			detail={d}
			tiers={tiers}
			open={vi.fn()}
			changed={changed}
			draft={draftOf()}
		/>
	);

describe("PlanCard", () => {
	it("forced off reads 'Forced off', not 'Not in tier'", () => {
		renderCard(detail());
		const r = within(row("QuickBooks"));
		expect(r.getByText("Forced off")).toBeInTheDocument();
		expect(r.getByText("Override")).toBeInTheDocument();
		expect(r.queryByText(/Not in/)).toBeNull();
	});

	it("explains a dependency block", () => {
		renderCard(detail());
		expect(
			within(row("Purchasing")).getByText("Off · requires Inventory")
		).toBeInTheDocument();
	});

	it("says which tier applies during a trial", () => {
		const d = detail();
		d.breakdown!.trialTier = {
			key: "max",
			label: "Max",
			version: 1,
			endsAt: "2026-10-21T12:00:00Z",
		};
		renderCard(d);
		expect(
			screen.getByText(/Max applies now; Pro applies after\./)
		).toBeInTheDocument();
	});

	it("marks changed rows", () => {
		renderCard(detail(), new Set(["inventory"]));
		expect(within(row("Inventory")).getByText(/Changed just now/)).toBeInTheDocument();
	});

	it("falls back to resolved state labels without a breakdown", () => {
		renderCard(detail({ breakdown: undefined }));
		expect(within(row("Inventory")).getByText("Not in tier")).toBeInTheDocument();
	});
});
