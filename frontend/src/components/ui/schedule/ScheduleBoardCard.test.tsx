import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import ScheduleBoardCard from "./ScheduleBoardCard";
import type { AssignedTech, CardModel } from "./cardModel";

const tech = (id: string, inFilter = true): AssignedTech => ({
	id,
	name: `Tech ${id}`,
	color: "#3b82f6",
	inFilter,
});

function model(over: Partial<CardModel> = {}): CardModel {
	return {
		kind: "visit",
		fromPlan: false,
		title: "Tune-up",
		client: "Smith Co",
		address: "12 Elm St",
		ref: "J-0012 · 3 items",
		techs: [tech("1")],
		priorityColor: "#3b82f6",
		constraint: {
			chip: { column: "9:00–11:00", inline: "9:00", sliver: "9a" },
			tone: "neutral",
			openEnded: false,
		},
		unassignedInFilter: true,
		ariaLabel: "Tune-up",
		...over,
	};
}

function renderCard(
	over: Partial<CardModel> = {},
	box = { width: 150, height: 112 },
	extra: { opacity?: number } = {}
) {
	const onClick = vi.fn();
	const utils = render(
		<ScheduleBoardCard
			cardId="c1"
			model={model(over)}
			top={0}
			left={0}
			zIndex={1}
			width={box.width}
			height={box.height}
			onClick={onClick}
			onMouseEnter={() => {}}
			onMouseLeave={() => {}}
			onDragStart={() => {}}
			{...extra}
		/>
	);
	const root = utils.container.querySelector<HTMLElement>("[data-card-id]")!;
	const q = (sel: string) => root.querySelector<HTMLElement>(sel);
	return { onClick, root, q, ...utils };
}

describe("ScheduleBoardCard — constraint marks", () => {
	it("fades the arrival window and paints the rest of the strip solid", () => {
		const { root, q } = renderCard({
			constraint: { ...model().constraint, tone: "window", windowBand: { from: 0.25, to: 0.75 } },
		});
		const band = q("[data-card-strip-band]")!;
		expect(band.style.opacity).toBe("0.35");
		expect(band.style.top).toBe("25%");
		expect(band.style.height).toBe("50%");
		const solid = [...root.querySelectorAll<HTMLElement>("[data-card-strip-solid]")];
		expect(solid.map((s) => [s.style.top, s.style.height, s.style.opacity])).toEqual([
			["0%", "25%", "1"],
			["75%", "25%", "1"],
		]);
	});

	it("fades the whole strip when the window covers the card", () => {
		const { q } = renderCard({
			constraint: { ...model().constraint, tone: "window", windowBand: { from: 0, to: 1 } },
		});
		expect(q("[data-card-strip-band]")!.style.height).toBe("100%");
		expect(q("[data-card-strip-solid]")).toBeNull();
	});

	it("stays solid when the window misses the card", () => {
		const { q } = renderCard({
			constraint: { ...model().constraint, tone: "window", windowBand: { from: 1, to: 1 } },
		});
		expect(q("[data-card-strip-band]")).toBeNull();
		expect(q("[data-card-strip-solid]")!.style.opacity).toBe("1");
	});

	it("keeps a solid strip for fixed arrivals", () => {
		const { q } = renderCard();
		expect(q("[data-card-strip-solid]")!.style.height).toBe("100%");
		expect(q("[data-card-strip-band]")).toBeNull();
	});

	it("draws the by tick only when the deadline is inside the card", () => {
		const inside = renderCard({
			constraint: { ...model().constraint, tone: "window", deadlineTick: 0.5 },
		});
		expect(inside.q("[data-card-tick]")!.style.top).toBe("50%");
		inside.unmount();
		expect(renderCard().q("[data-card-tick]")).toBeNull();
	});
});

describe("ScheduleBoardCard — modes", () => {
	it("renders a sliver with the short time and no title", () => {
		const { root, q } = renderCard({}, { width: 40, height: 112 });
		expect(root.dataset.cardMode).toBe("sliver");
		expect(q("[data-card-chip]")!.textContent).toBe("9a");
		expect(q("[data-card-title]")).toBeNull();
	});

	it("renders inline with the short chip and a one-line title", () => {
		const { root, q } = renderCard({}, { width: 150, height: 30 });
		expect(root.dataset.cardMode).toBe("inline");
		expect(q("[data-card-chip]")!.textContent).toBe("9:00");
		expect(q("[data-card-title]")!.style.whiteSpace).toBe("nowrap");
	});

	it("renders the column rows who-and-where first", () => {
		const { q } = renderCard({}, { width: 150, height: 112 });
		expect(q("[data-card-chip]")!.textContent).toBe("9:00–11:00");
		expect(q("[data-card-row='client']")!.textContent).toBe("Smith Co");
		expect(q("[data-card-row='address']")!.textContent).toBe("12 Elm St");
		expect(q("[data-card-row='ref']")!.textContent).toBe("J-0012 · 3 items");
	});

	it("ellipsizes secondary rows instead of widening the card", () => {
		const { q } = renderCard({ address: "9".repeat(200) }, { width: 150, height: 112 });
		const row = q("[data-card-row='address']")!;
		expect(row.style.whiteSpace).toBe("nowrap");
		expect(row.style.textOverflow).toBe("ellipsis");
	});

	it("sets the aria-label in every mode", () => {
		for (const box of [
			{ width: 40, height: 112 },
			{ width: 150, height: 30 },
			{ width: 150, height: 112 },
		]) {
			const { root, unmount } = renderCard({ ariaLabel: "Tune-up, 9:00–11:00, Smith Co" }, box);
			expect(root.getAttribute("aria-label")).toBe("Tune-up, 9:00–11:00, Smith Co");
			unmount();
		}
	});
});

describe("ScheduleBoardCard — variants and behaviour", () => {
	it("renders occurrences with the plan mark, italic title and Unassigned slot", () => {
		const { root, q } = renderCard({ kind: "occurrence", fromPlan: true, techs: [] });
		expect(root.dataset.cardKind).toBe("occurrence");
		expect(q("[data-card-title]")!.style.fontStyle).toBe("italic");
		expect(q("[data-card-title] [data-card-plan-mark]")).not.toBeNull();
		expect(q("[data-card-unassigned]")!.textContent).toBe("Unassigned");
	});

	it("dims the Unassigned slot while a tech filter is active", () => {
		const { q } = renderCard({ kind: "occurrence", techs: [], unassignedInFilter: false });
		expect(q("[data-card-unassigned]")!.style.opacity).toBe("0.4");
	});

	it("marks off-filter techs", () => {
		const { root } = renderCard({ techs: [tech("1"), tech("2", false)] });
		const flags = [...root.querySelectorAll<HTMLElement>("[data-card-tech]")].map(
			(el) => el.dataset.inFilter
		);
		expect(flags).toEqual(["true", "false"]);
	});

	it("shows a muted plan mark in the chip row for visits from a plan", () => {
		const { q } = renderCard({ fromPlan: true });
		expect(q("[data-card-chip]")!.parentElement!.querySelector("[data-card-plan-mark]")).not.toBeNull();
	});

	it("shows a status pill next to the chip", () => {
		const { q } = renderCard({ status: "Driving" });
		expect(q("[data-card-status]")!.textContent).toBe("Driving");
	});

	it("keeps the stock badge and the open-ended edge", () => {
		const { q } = renderCard({
			stockWarning: "out",
			constraint: { ...model().constraint, openEnded: true },
		});
		expect(q("[data-card-stock='out']")).not.toBeNull();
		expect(q("[data-card-open-end]")).not.toBeNull();
	});

	it("activates on Enter and Space", () => {
		const { root, onClick } = renderCard();
		fireEvent.keyDown(root, { key: "Enter" });
		fireEvent.keyDown(root, { key: " " });
		expect(onClick).toHaveBeenCalledTimes(2);
	});

	it("stops catching pointer events while hidden for a pending drop", () => {
		const { root } = renderCard({}, undefined, { opacity: 0 });
		expect(root.style.pointerEvents).toBe("none");
		expect(root.getAttribute("draggable")).toBe("true");
	});
});
