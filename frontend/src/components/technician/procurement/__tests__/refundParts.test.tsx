import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RefundPartPicker, { RefundLineStock } from "../RefundPartPicker";
import { partsSummary, refundLedger, returnableParts } from "../refundParts";
import { blankLine, type LineDraft } from "../lineDrafts";
import { pendingRefundsLine, refundStatusLabel, sheetCopy, sheetTitle } from "../sheetCopy";
import type { FieldPurchaseRefundParentLine } from "../../../../types/fieldPurchases";

const ITEM = "item-1";
const pline = (
	over: Partial<FieldPurchaseRefundParentLine> = {}
): FieldPurchaseRefundParentLine => ({
	id: "pl-1",
	description: "Capacitor",
	inventory_item_id: ITEM,
	unit_price: "20.00",
	quantity: "3",
	returnable_qty: "3",
	disposition: "receive",
	vehicle_name: "Van 2",
	...over,
});
const draft = (over: Partial<LineDraft> = {}): LineDraft => ({ ...blankLine("a"), ...over });

describe("returnableParts", () => {
	it("groups one item across lines and nets what is already on the sheet", () => {
		const parts = returnableParts(
			[pline(), pline({ id: "pl-2", returnable_qty: "2", vehicle_name: null })],
			[draft({ inventory_item_id: ITEM, quantity: "1" })]
		);
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ left: 4, from: "Van 2" });
	});

	it("keeps an unlinked line as itself, with nowhere for stock to come from", () => {
		const [part] = returnableParts(
			[pline({ inventory_item_id: null, disposition: "non_stock" })],
			[]
		);
		expect(part).toMatchObject({ inventory_item_id: null, from: null, left: 3 });
	});
});

describe("RefundPartPicker", () => {
	it("adds a linked, unconfirmed line priced from the purchase", async () => {
		const onChange = vi.fn();
		render(
			<RefundPartPicker
				parentLines={[pline()]}
				lines={[]}
				allocationKey="a"
				onChange={onChange}
			/>
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Add Capacitor to this refund" })
		);
		const [added] = onChange.mock.calls[0][0] as LineDraft[];
		expect(added).toMatchObject({
			description: "Capacitor",
			inventory_item_id: ITEM,
			unit_price: "20.00",
			quantity: "1",
			acknowledged: false,
		});
	});

	it("bumps the quantity of a part already on the sheet", async () => {
		const onChange = vi.fn();
		const existing = draft({
			inventory_item_id: ITEM,
			quantity: "1",
			acknowledged: true,
		});
		render(
			<RefundPartPicker
				parentLines={[pline()]}
				lines={[existing]}
				allocationKey="a"
				onChange={onChange}
			/>
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Add Capacitor to this refund" })
		);
		expect(onChange.mock.calls[0][0][0]).toMatchObject({
			quantity: "2",
			acknowledged: false,
		});
	});

	it("offers nothing once every part is accounted for", () => {
		const { container } = render(
			<RefundPartPicker
				parentLines={[pline({ returnable_qty: "0" })]}
				lines={[]}
				allocationKey="a"
				onChange={vi.fn()}
			/>
		);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("RefundLineStock", () => {
	it("says where stock comes off", () => {
		render(
			<RefundLineStock
				draft={draft({ inventory_item_id: ITEM })}
				parentLines={[pline()]}
			/>
		);
		expect(screen.getByText("Comes off Van 2 when approved")).toBeInTheDocument();
	});

	it("warns past what can come back", () => {
		render(
			<RefundLineStock
				draft={draft({ inventory_item_id: ITEM, quantity: "5" })}
				parentLines={[pline()]}
			/>
		);
		expect(
			screen.getByText("Only 3 of these can come back off stock")
		).toBeInTheDocument();
	});

	it("is honest about a typed line", () => {
		render(
			<RefundLineStock
				draft={draft({ description: "Misc" })}
				parentLines={[pline()]}
			/>
		);
		expect(screen.getByText(/No stock comes off/)).toBeInTheDocument();
	});
});

describe("sheetCopy", () => {
	it("keeps the purchase wording and gives the refund its own", () => {
		expect(sheetCopy("purchase").totalLabel).toBe("Total paid");
		expect(sheetCopy("refund").totalLabel).toBe("Credit total");
		expect(sheetCopy("refund").submitLabel).toBe("Send refund to dispatch");
	});

	it("titles a purchase by its status and a refund by where the money is", () => {
		expect(
			sheetTitle({ kind: "purchase", status: "draft", refund_settled_at: null })
		).toBe("New field purchase");
		expect(refundStatusLabel({ status: "approved", refund_settled_at: null })).toBe(
			"Refund · Credit on its way"
		);
	});

	it("pluralises the pending line", () => {
		expect(pendingRefundsLine(1, "$42.00")).toBe("1 refund pending · $42.00");
		expect(pendingRefundsLine(2, "$50.00")).toBe("2 refunds pending · $50.00");
	});
});

describe("partsSummary", () => {
	it("names two parts, counts the rest, and shows quantity only above one", () => {
		expect(
			partsSummary([
				{ description: "Capacitor", quantity: "2" },
				{ description: "Tape", quantity: "1" },
				{ description: "Fuse", quantity: "1" },
			])
		).toBe("Capacitor ×2, Tape +1 more");
		expect(partsSummary([])).toBeNull();
		// A server older than this client sends no parts at all; that crashed the page.
		expect(partsSummary(undefined)).toBeNull();
	});
});

describe("refundLedger", () => {
	const summary = {
		draft_id: null,
		in_progress_count: 1,
		in_progress_value: "42",
		approved_value: "10",
		settled_value: "8",
		remaining: "60",
		refunds: [],
	};

	it("takes only a landed credit off the net", () => {
		expect(refundLedger(120, summary)).toMatchObject({
			received: 8,
			onItsWay: 10,
			withDispatch: 42,
			net: 112,
			stillRefundable: 60,
		});
	});

	it("leaves the net at what was paid when nothing has landed", () => {
		expect(refundLedger(120, { ...summary, settled_value: "0" }).net).toBe(120);
	});
});
