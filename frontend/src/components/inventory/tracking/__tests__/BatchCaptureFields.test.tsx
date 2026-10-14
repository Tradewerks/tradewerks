import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "../../../../test/testUtils";
import BatchCaptureFields, { type BatchCaptureValue } from "../BatchCaptureFields";
import type { BatchListRow } from "../../../../types/tracking";

const OPEN_BATCH: BatchListRow = {
	id: "batch-open",
	code: "BATCH-OPEN-CODE",
	batch_number: "LOT-100",
	expires_at: "2027-01-15T00:00:00.000Z",
	supplier: "Acme Supply",
	recalled_at: null,
	qty_received: 50,
	qty_in_warehouse: 30,
	vehicles: [],
};

const RECALLED_BATCH: BatchListRow = {
	id: "batch-recalled",
	code: "BATCH-RECALLED-CODE",
	batch_number: "LOT-BAD",
	expires_at: null,
	supplier: "Bad Supplier",
	recalled_at: "2026-06-01T00:00:00.000Z",
	qty_received: 20,
	qty_in_warehouse: 5,
	vehicles: [],
};

const mockUseBatchesQuery = vi.fn();

vi.mock("../../../../hooks/useTracking", () => ({
	useBatchesQuery: (itemId: string) => mockUseBatchesQuery(itemId),
}));

function Harness({ initialValue }: { initialValue: BatchCaptureValue }) {
	const [value, setValue] = useState<BatchCaptureValue>(initialValue);
	return <BatchCaptureFields itemId="item-1" value={value} onChange={setValue} />;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockUseBatchesQuery.mockReturnValue({
		data: { batches: [OPEN_BATCH, RECALLED_BATCH] },
	});
});

describe("typing a known batch number", () => {
	it("switches to existing mode and shows its expiry read-only", async () => {
		render(<Harness initialValue={{ mode: "new", batch_number: "", expires_at: null }} />);

		const input = screen.getByLabelText("Batch or lot number");
		await userEvent.type(input, "LOT-100");

		await waitFor(() => {
			expect(screen.getByText(/Receiving into existing lot LOT-100/)).toBeInTheDocument();
		});

		const expiryField = screen.getByLabelText("Expiry date (read-only)") as HTMLInputElement;
		expect(expiryField).toHaveValue("2027-01-15");
		expect(expiryField).toBeDisabled();
	});
});

describe("typing an unknown batch number", () => {
	it("stays in new mode with an editable expiry and no lot-level supplier field", async () => {
		render(<Harness initialValue={{ mode: "new", batch_number: "", expires_at: null }} />);

		const input = screen.getByLabelText("Batch or lot number");
		await userEvent.type(input, "BRAND-NEW-LOT");

		expect(screen.queryByText(/Receiving into existing lot/)).not.toBeInTheDocument();
		expect(screen.getByLabelText("Expiry date")).not.toBeDisabled();
		// The vendor is captured once per receipt, not per lot.
		expect(screen.queryByLabelText("Supplier")).not.toBeInTheDocument();
	});
});

describe("recalled batches", () => {
	it("shows recalled batches in the dropdown flagged and not selectable", async () => {
		render(<Harness initialValue={{ mode: "new", batch_number: "", expires_at: null }} />);

		const input = screen.getByLabelText("Batch or lot number");
		await userEvent.click(input);

		const recalledOption = await screen.findByLabelText("LOT-BAD (recalled)");
		expect(recalledOption).toBeDisabled();
		expect(screen.getByText("Recalled")).toBeInTheDocument();
	});

	it("does not switch to existing mode when typing a recalled batch's number", async () => {
		render(<Harness initialValue={{ mode: "new", batch_number: "", expires_at: null }} />);

		const input = screen.getByLabelText("Batch or lot number");
		await userEvent.type(input, "LOT-BAD");

		expect(screen.queryByText(/Receiving into existing lot/)).not.toBeInTheDocument();
		expect(screen.getByLabelText("Expiry date")).not.toBeDisabled();
	});
});
