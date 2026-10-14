import { describe, expect, it } from "vitest";
import { CARD_METRICS as M, planCardLayout, techRowHeight, type CardLayout } from "./cardLayout";
import type { AssignedTech, CardModel } from "./cardModel";

const tech = (id: string): AssignedTech => ({ id, name: `Tech ${id}`, color: "#3b82f6", inFilter: true });

function model(over: Partial<CardModel> = {}): CardModel {
	return {
		kind: "visit",
		fromPlan: false,
		title: "Tune-up",
		client: "Smith Co",
		address: "12 Elm St",
		ref: "J-0012 · 3 items",
		description: "Replace the condenser fan motor and check refrigerant charge on both circuits.",
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

// Independent of the planner: stacked rows + gaps, tech row included.
function usedHeight(l: CardLayout): number {
	const rows: number[] = [];
	if (l.chip) rows.push(M.CHIP_H);
	if (l.titleLines) rows.push(l.titleLines * M.TITLE_LH);
	if (l.client) rows.push(M.SECONDARY_LH);
	if (l.address) rows.push(M.SECONDARY_LH);
	if (l.ref) rows.push(M.SECONDARY_LH);
	if (l.descriptionLines) rows.push(l.descriptionLines * M.SECONDARY_LH);
	if (techRowHeight(l.tech)) rows.push(techRowHeight(l.tech));
	return rows.reduce((a, b) => a + b, 0) + M.ROW_GAP * Math.max(0, rows.length - 1);
}

describe("planCardLayout — modes", () => {
	it("goes sliver below 56px of content width", () => {
		expect(planCardLayout(model(), 69, 112).mode).toBe("sliver");
		expect(planCardLayout(model(), 70, 112).mode).toBe("column");
	});

	it("goes inline below 44px of height", () => {
		expect(planCardLayout(model(), 150, 43).mode).toBe("inline");
		expect(planCardLayout(model(), 150, 44).mode).toBe("column");
	});

	it("sliver stacks as many dots as fit under the time", () => {
		const l = planCardLayout(model({ techs: [tech("1"), tech("2"), tech("3")] }), 40, 56);
		expect(l).toMatchObject({ mode: "sliver", tech: "dots", maxDots: 3, titleLines: 0 });
		expect(planCardLayout(model(), 40, 28).maxDots).toBe(0);
	});

	it("inline leaves room for the chip and title before adding dots", () => {
		expect(planCardLayout(model(), 70, 30).maxDots).toBe(0);
		expect(planCardLayout(model({ techs: [tech("1"), tech("2")] }), 150, 30)).toMatchObject({
			mode: "inline",
			titleLines: 1,
			tech: "dots",
			maxDots: 2,
		});
	});
});

describe("planCardLayout — column rows", () => {
	it("keeps a title line, then the chip, before anything else", () => {
		expect(planCardLayout(model(), 150, 60)).toMatchObject({
			chip: true,
			titleLines: 1,
			client: false,
			address: false,
			ref: false,
			descriptionLines: 0,
			tech: "bubbles",
		});
	});

	it("adds client exactly when it fits whole", () => {
		expect(planCardLayout(model(), 150, 68).client).toBe(false);
		expect(planCardLayout(model(), 150, 69)).toMatchObject({ client: true, address: false });
	});

	it("gives a long title its second line before the client", () => {
		const long = model({ title: "Rooftop Unit Replacement — Smith Commercial Building 2" });
		expect(planCardLayout(long, 150, 76)).toMatchObject({ titleLines: 2, client: false });
	});

	it("caps a long unbroken title at two lines", () => {
		const l = planCardLayout(model({ title: "X".repeat(120) }), 150, 300);
		expect(l.titleLines).toBe(2);
	});

	it("shows optional rows only as an in-order prefix", () => {
		const order: (keyof CardLayout)[] = ["client", "address", "ref"];
		for (let h = 44; h <= 300; h++) {
			const l = planCardLayout(model(), 150, h);
			const shown = order.map((k) => l[k] === true);
			const firstHidden = shown.indexOf(false);
			if (firstHidden !== -1) expect(shown.slice(firstHidden).every((s) => !s)).toBe(true);
		}
	});

	it("gates the description on three free lines", () => {
		expect(planCardLayout(model(), 150, 134).descriptionLines).toBe(0);
		expect(planCardLayout(model(), 150, 135).descriptionLines).toBe(2);
	});

	it("never clips a row", () => {
		const variants = [
			model(),
			model({ techs: [] }),
			model({ kind: "occurrence", techs: [] }),
			model({ constraint: { ...model().constraint, openEnded: true } }),
			model({ techs: Array.from({ length: 8 }, (_, i) => tech(String(i))) }),
		];
		for (const m of variants) {
			for (const w of [70, 96, 150, 220]) {
				for (let h = 44; h <= 320; h += 3) {
					const l = planCardLayout(m, w, h);
					expect(usedHeight(l), `${w}x${h}`).toBeLessThanOrEqual(l.contentH);
				}
			}
		}
	});

	it("reserves the open-ended edge", () => {
		const open = model({ constraint: { ...model().constraint, openEnded: true } });
		expect(planCardLayout(open, 150, 69).client).toBe(false);
	});
});

describe("planCardLayout — tech row", () => {
	it("shrinks bubbles to dots before dropping the time chip", () => {
		const open = model({ constraint: { ...model().constraint, openEnded: true } });
		const l = planCardLayout(open, 150, 56);
		expect(l.chip).toBe(true);
		expect(l.tech).toBe("dots");
	});

	it("falls back to dots when bubbles do not fit the width", () => {
		const six = model({ techs: Array.from({ length: 6 }, (_, i) => tech(String(i))) });
		expect(planCardLayout(six, 100, 112)).toMatchObject({ tech: "dots", maxDots: 6 });
	});

	it("leaves room for a +N overflow label", () => {
		const twelve = model({ techs: Array.from({ length: 12 }, (_, i) => tech(String(i))) });
		expect(planCardLayout(twelve, 100, 112).maxDots).toBe(7);
	});

	it("gives occurrences an Unassigned slot", () => {
		const occ = model({ kind: "occurrence", techs: [] });
		expect(planCardLayout(occ, 150, 56)).toMatchObject({ tech: "unassigned", chip: true, titleLines: 1 });
	});

	it("has no tech row for an unstaffed visit", () => {
		expect(planCardLayout(model({ techs: [] }), 150, 112).tech).toBe("none");
	});
});
