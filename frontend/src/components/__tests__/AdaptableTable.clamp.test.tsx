import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../test/testUtils";
import AdaptableTable from "../AdaptableTable";

// jsdom can't measure overflow, so these assert the clamp mechanism itself
// (wrapper placement, clamp class, title fallback) rather than pixels.

const pad = (text: string, len: number, filler = "X") =>
	(text + filler.repeat(len)).slice(0, len).trimEnd();

const MAX_NAME = pad(
	"MAXLEN STRESS TEST — Universal High-Efficiency Variable-Speed Heat Pump Kit",
	255,
	" Lorem ipsum dolor sit amet",
);
const MAX_SKU = pad("STRESS-MAXLEN-SKU-", 100);

const rows = [
	{
		id: "item-1",
		item: MAX_NAME,
		sku: MAX_SKU,
		onHand: "99999999.99 cylinders",
		health: "Reorder now",
	},
];

const CLAMP = {
	item: { maxWidth: "22rem", lines: 2 as const },
	sku: { maxWidth: "11rem" },
	onHand: { lines: 1 as const },
};

const renderTable = () => render(<AdaptableTable data={rows} columnClamp={CLAMP} />);

/** The clamp wrapper for a cell, found through the text it holds. */
const wrapperFor = (text: string) => screen.getByText(text).closest("div");

describe("AdaptableTable column clamp", () => {
	it("caps a multi-line column on a wrapper inside the cell, not on the cell", () => {
		renderTable();
		const wrapper = wrapperFor(MAX_NAME);

		// Cap lives on the wrapper, not the <td> — auto layout ignores a width on the cell itself.
		expect(wrapper).toHaveStyle({ maxWidth: "22rem" });
		expect(wrapper?.className).toContain("line-clamp-2");
		expect(wrapper?.className).toContain("break-words");
		expect(wrapper?.tagName).toBe("DIV");
		expect(wrapper?.closest("td")).not.toBeNull();
	});

	it("truncates a single-line column to one line", () => {
		renderTable();
		const wrapper = wrapperFor(MAX_SKU);

		expect(wrapper).toHaveStyle({ maxWidth: "11rem" });
		expect(wrapper?.className).toContain("truncate");
	});

	it("fill sizes the column at the cap but stretches to the cell", () => {
		render(<AdaptableTable data={rows} columnClamp={{ sku: { maxWidth: "11rem", fill: true } }} />);
		const wrapper = wrapperFor(MAX_SKU) as HTMLElement | null;

		expect(wrapper).toHaveStyle({ width: "11rem", minWidth: "100%" });
		expect(wrapper?.style.maxWidth).toBe("");
	});

	it("keeps the full value reachable on hover", () => {
		renderTable();

		expect(screen.getByTitle(MAX_NAME)).toBeInTheDocument();
		expect(screen.getByTitle(MAX_SKU)).toBeInTheDocument();
	});

	it("leaves computed values uncapped, so a quantity is never clipped", () => {
		renderTable();
		const wrapper = wrapperFor("99999999.99 cylinders");

		// No cap here — a cut quantity would just be a wrong number.
		expect(wrapper?.className).toContain("truncate");
		expect((wrapper as HTMLElement | null)?.style.maxWidth).toBe("");
	});

	it("skips the tooltip on short values", () => {
		renderTable();

		expect(screen.queryByTitle("Reorder now")).toBeNull();
	});

	it("renders unclamped columns without a wrapper", () => {
		render(<AdaptableTable data={rows} />);

		expect(screen.getByText(MAX_SKU).tagName).toBe("TD");
	});
});
