import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QBSyncNowResult, QBUnsyncedDoc } from "../../../api/quickbooks";

let docs: QBUnsyncedDoc[] = [];
let syncResult: QBSyncNowResult | undefined;
const sync = { mutate: vi.fn(), isPending: false, get data() { return syncResult; } };
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBUnsyncedQuery: () => ({ data: docs }),
	useQBSyncNowMutation: () => sync,
}));

import QuickBooksUnsyncedCard from "../QuickBooksUnsyncedCard";

const doc = (id: string, status: QBUnsyncedDoc["status"]): QBUnsyncedDoc => ({
	type: "invoice",
	id,
	label: `INV-${id}`,
	status,
	updated_at: "2026-11-01T00:00:00.000Z",
});

describe("QuickBooksUnsyncedCard", () => {
	beforeEach(() => {
		docs = [];
		syncResult = undefined;
	});

	it("disables Sync now when every listed document is diverged", () => {
		docs = [doc("1", "diverged")];
		render(<QuickBooksUnsyncedCard connected />);
		expect(screen.getByText("1 to reconcile in QuickBooks")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Sync now/ })).toBeDisabled();
	});

	it("keeps Sync now enabled when at least one document can be synced", () => {
		docs = [doc("1", "diverged"), doc("2", "not_synced")];
		render(<QuickBooksUnsyncedCard connected />);
		expect(screen.getByRole("button", { name: /Sync now/ })).toBeEnabled();
	});

	it("lists each document the last sync could not push, with the reason", () => {
		docs = [doc("2", "failed")];
		syncResult = {
			synced: 0,
			failed: [{ type: "invoice", id: "2", label: "INV-2", message: "Customer is inactive in QuickBooks" }],
		};
		render(<QuickBooksUnsyncedCard connected />);
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("1 could not be synced");
		expect(alert).toHaveTextContent("INV-2");
		expect(alert).toHaveTextContent("Customer is inactive in QuickBooks");
	});
});
