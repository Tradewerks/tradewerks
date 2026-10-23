import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaxSourceChip, TAX_SOURCE_LABEL } from "../TaxSourceChip";
import type { TaxSource } from "../../../types/tax";

describe("TaxSourceChip", () => {
	const cases: [TaxSource, string][] = [
		["provider", "Auto address rate"],
		["manual_override", "Tax group"],
		["cached_stale", "Last known rate"],
		["org_default", "Default group"],
		["legacy", "Organization rate"],
		["qb_ast", "QuickBooks"],
	];

	it.each(cases)("renders %s as %s", (source, label) => {
		render(<TaxSourceChip source={source} />);
		expect(screen.getByText(label)).toBeInTheDocument();
		expect(TAX_SOURCE_LABEL[source].label).toBe(label);
	});

	it("renders nothing for null and undefined", () => {
		const a = render(<TaxSourceChip source={null} />);
		expect(a.container.firstChild).toBeNull();
		const b = render(<TaxSourceChip source={undefined} />);
		expect(b.container.firstChild).toBeNull();
	});

	it("exposes the explanatory title", () => {
		render(<TaxSourceChip source="cached_stale" />);
		expect(screen.getByText("Last known rate")).toHaveAttribute(
			"title",
			"The address lookup failed; using the last rate found for this address"
		);
	});

	it("renders nothing for an unrecognized source", () => {
		const { container } = render(
			<TaxSourceChip source={"future_source" as TaxSource} />
		);
		expect(container.firstChild).toBeNull();
	});

	it("labels a kept address rate", () => {
		render(<TaxSourceChip source="provider" kept />);
		const chip = screen.getByText("Address rate (from auto mode)");
		expect(chip).toHaveAttribute(
			"title",
			"Taxed at the address rate found while automatic tax was on",
		);
	});

	it("ignores kept for non-address sources", () => {
		render(<TaxSourceChip source="manual_override" kept />);
		expect(screen.getByText("Tax group")).toBeInTheDocument();
	});
});
