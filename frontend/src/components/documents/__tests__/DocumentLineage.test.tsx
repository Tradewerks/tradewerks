import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import DocumentLineage from "../DocumentLineage";
import type { DocumentLineage as Lineage, LineageNode } from "../../../types/lineage";

const node = (v: number, status = "Revised"): LineageNode => ({
	id: `q${v}`,
	number: `QUO-100${v}`,
	version: v,
	status,
});

const lineage = (over: Partial<Lineage> = {}): Lineage => {
	const chain = over.chain ?? [node(1), node(2), node(3), node(4, "Sent")];
	const self_id = over.self_id ?? "q2";
	const index = chain.findIndex((n) => n.id === self_id);
	return {
		self_id,
		self_version: chain[index].version,
		latest_version: chain[chain.length - 1].version,
		chain,
		truncated_before: false,
		successor: chain[index + 1] ?? null,
		final: chain[chain.length - 1],
		final_is_live: true,
		adjusts: null,
		adjustments: [],
		...over,
	};
};

const renderChips = (value: Lineage | null, kind: "quote" | "invoice" = "quote") =>
	render(
		<MemoryRouter>
			<DocumentLineage kind={kind} lineage={value} />
		</MemoryRouter>
	);

/** The chip is a disclosure; most of the chain only exists once it is open. */
const openPanel = () => fireEvent.click(screen.getByRole("button", { name: /Version|adjust/i }));

describe("DocumentLineage", () => {
	it("renders nothing for a v1 document with no successor and no adjustments", () => {
		const { container } = renderChips(
			lineage({ self_id: "q1", chain: [node(1, "Sent")] })
		);

		expect(container.textContent).toBe("");
	});

	it("renders nothing when there is no lineage at all", () => {
		const { container } = renderChips(null);

		expect(container.textContent).toBe("");
	});

	it("states the position and links the chain tail without being opened", () => {
		renderChips(lineage());

		expect(screen.getByRole("button", { name: /Version 2 of 4/ })).toBeTruthy();

		const link = screen.getByRole("link", { name: /Current QUO-1004/ });
		expect(link.getAttribute("href")).toBe("/dispatch/quotes/q4");
	});

	// The reason the surface exists: from two hops behind, the document that
	// counts is one click away and needs no disclosure opened to find.
	it("links the tail even when it is not the immediate successor", () => {
		renderChips(lineage());

		expect(screen.getByRole("link", { name: /Current QUO-1004/ })).toBeTruthy();

		openPanel();

		expect(screen.getByRole("link", { name: /QUO-1003/ })).toBeTruthy();
	});

	// Two chips, whatever the depth — the collapsed header must not grow a link
	// per version.
	it("shows at most one link while closed, however deep the chain", () => {
		const chain = [1, 2, 3, 4, 5, 6].map((v) => node(v, v === 6 ? "Sent" : "Revised"));
		renderChips(lineage({ self_id: "q2", chain }));

		expect(screen.getAllByRole("link")).toHaveLength(1);
		expect(screen.queryByRole("link", { name: /QUO-1005/ })).toBeNull();

		openPanel();

		expect(screen.getByRole("link", { name: /QUO-1005/ })).toBeTruthy();
		// The viewed document is listed but is not a link to itself.
		expect(screen.queryByRole("link", { name: /QUO-1002/ })).toBeNull();
		expect(screen.getByText("This version")).toBeTruthy();
	});

	it("says nothing about a current version when the document IS the tail", () => {
		renderChips(lineage({ self_id: "q4" }));

		expect(screen.getByRole("button", { name: /Version 4 of 4/ })).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("calls a terminal tail the latest version, not the current one", () => {
		renderChips(
			lineage({
				chain: [node(1), node(2), node(3), node(4, "Cancelled")],
				final_is_live: false,
			})
		);

		// The dispatcher still needs to reach it.
		expect(screen.getByRole("link", { name: /Latest QUO-1004/ })).toBeTruthy();
		expect(screen.queryByRole("link", { name: /Current QUO-1004/ })).toBeNull();

		openPanel();

		expect(screen.getByText(/No active version in this chain/i)).toBeTruthy();
	});

	it("says earlier versions were deleted rather than inventing a hop", () => {
		renderChips(
			lineage({
				self_id: "q3",
				chain: [node(3), node(4, "Sent")],
				truncated_before: true,
			})
		);

		expect(screen.getByRole("button", { name: /Version 3 of 4/ })).toBeTruthy();

		openPanel();

		expect(screen.getByText(/Earlier versions were deleted/i)).toBeTruthy();
		expect(screen.queryByRole("link", { name: /QUO-1001/ })).toBeNull();
	});

	it("closes on Escape and hands focus back to the chip", () => {
		renderChips(lineage());
		const chip = screen.getByRole("button", { name: /Version 2 of 4/ });

		fireEvent.click(chip);
		expect(chip.getAttribute("aria-expanded")).toBe("true");

		fireEvent.keyDown(screen.getByLabelText("Version history"), { key: "Escape" });

		expect(chip.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(chip);
	});

	// DetailHeader's statusPill is the page's only status word.
	it("never prints the viewed document's own status", () => {
		renderChips(
			lineage({
				self_id: "q2",
				chain: [node(1), node(2, "Rejected"), node(3, "Sent")],
			})
		);
		openPanel();

		expect(screen.queryByText(/Rejected/)).toBeNull();
	});

	it("renders both adjustment directions for an invoice", () => {
		const self: LineageNode = {
			id: "i5",
			number: "INV-1005",
			version: 1,
			status: "Sent",
		};
		renderChips(
			{
				self_id: "i5",
				self_version: 1,
				latest_version: 1,
				chain: [self],
				truncated_before: false,
				successor: null,
				final: self,
				final_is_live: true,
				adjusts: {
					id: "i1",
					number: "INV-1001",
					version: 1,
					status: "Sent",
				},
				adjustments: [
					{
						id: "i9",
						number: "INV-1009",
						version: 1,
						status: "Sent",
					},
				],
			},
			"invoice"
		);

		// No chain, so the chip names the relationship instead of a position.
		expect(screen.getByRole("button", { name: /2 adjustments/ })).toBeTruthy();

		openPanel();

		expect(screen.getByText(/Adjusts/i)).toBeTruthy();
		expect(screen.getByRole("link", { name: /INV-1001/ }).getAttribute("href")).toBe(
			"/dispatch/invoices/i1"
		);
		expect(screen.getByText(/Adjusted by/i)).toBeTruthy();
		expect(screen.getByRole("link", { name: /INV-1009/ })).toBeTruthy();
	});
});
