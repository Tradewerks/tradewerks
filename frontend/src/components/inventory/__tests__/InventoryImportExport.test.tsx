import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "../../../test/testUtils";
import InventoryImportExport from "../InventoryImportExport";

const mockImport = vi.fn();
const mockDownloadTemplate = vi.fn();
const mockExportLowStock = vi.fn();
const draftWorkflowEnabled = import.meta.env.VITE_INVENTORY_AI_IMPORT_ENABLED === "true";

vi.mock("../../../api/inventory", () => ({
	importInventory: (...args: unknown[]) => mockImport(...args),
	downloadInventoryTemplate: (...args: unknown[]) => mockDownloadTemplate(...args),
	exportLowStockInventory: (...args: unknown[]) => mockExportLowStock(...args),
}));

function renderOpen() {
	return render(<InventoryImportExport isOpen={true} onClose={vi.fn()} />);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockImport.mockResolvedValue({ imported: 0, skipped: [] });
	mockDownloadTemplate.mockResolvedValue(undefined);
	mockExportLowStock.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
describe("rendering", () => {
	it("renders the modal when isOpen is true", () => {
		renderOpen();
		expect(screen.getByText("Import / Export")).toBeInTheDocument();
	});

	it("renders nothing when isOpen is false", () => {
		render(<InventoryImportExport isOpen={false} onClose={vi.fn()} />);
		expect(screen.queryByText("Import / Export")).not.toBeInTheDocument();
	});

	it.skipIf(draftWorkflowEnabled)("shows the drop zone hint text", () => {
		renderOpen();
		expect(screen.getByText(/drop a file here/i)).toBeInTheDocument();
	});

	it.skipIf(draftWorkflowEnabled)("shows accepted file format hint", () => {
		renderOpen();
		expect(screen.getByText(".xlsx, .xls, .csv")).toBeInTheDocument();
	});

	it("shows the Download Template button", () => {
		renderOpen();
		expect(screen.getByText(/download template/i)).toBeInTheDocument();
	});

	it("shows the Export Low Stock List button", () => {
		renderOpen();
		expect(screen.getByText(/export low stock list/i)).toBeInTheDocument();
	});

	it.skipIf(draftWorkflowEnabled)("import button is disabled when no file is selected", () => {
		renderOpen();
		expect(screen.getByRole("button", { name: /import items/i })).toBeDisabled();
	});
});

describe.runIf(draftWorkflowEnabled)("reviewed import workflow", () => {
	it("explains that stock changes wait for review and approval", () => {
		renderOpen();
		expect(screen.getByText(/persistent drafts/i)).toBeInTheDocument();
		expect(screen.getByText(/approval before stock changes/i)).toBeInTheDocument();
	});

	it("offers the reviewed import and history destinations", () => {
		renderOpen();
		expect(screen.getByRole("button", { name: "Start reviewed import" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "View import history" })).toBeInTheDocument();
	});

	it("does not expose the retired direct-write file picker", () => {
		renderOpen();
		expect(document.querySelector('input[type="file"]')).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Import Items" })).not.toBeInTheDocument();
		expect(mockImport).not.toHaveBeenCalled();
	});

	it("closes the modal when the reviewed import is opened", async () => {
		const onClose = vi.fn();
		render(<InventoryImportExport isOpen={true} onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Start reviewed import" }));
		expect(onClose).toHaveBeenCalledOnce();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// File selection
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(draftWorkflowEnabled)("file selection", () => {
	it("shows the filename after a valid file is selected", async () => {
		renderOpen();
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["data"], "items.xlsx", {
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});

		await userEvent.upload(input, file);

		expect(screen.getByText("items.xlsx")).toBeInTheDocument();
	});

	it("enables the import button after a valid file is selected", async () => {
		renderOpen();
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["data"], "items.csv", { type: "text/csv" });

		await userEvent.upload(input, file);

		expect(screen.getByRole("button", { name: /import items/i })).not.toBeDisabled();
	});

	it("shows an error for an unsupported file type via drag-and-drop", async () => {
		renderOpen();
		const dropZone = document.querySelector(".border-dashed") as HTMLElement;
		const file = new File(["data"], "report.pdf", { type: "application/pdf" });

		// Use drop event since userEvent.upload filters by the input's accept attribute
		act(() => {
			fireEvent.drop(dropZone, {
				dataTransfer: { files: [file] },
			});
		});

		expect(screen.getByText(/invalid file type/i)).toBeInTheDocument();
	});

	it("clears the selected file when the X button is clicked", async () => {
		renderOpen();
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["data"], "items.xlsx", {
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});

		await userEvent.upload(input, file);
		expect(screen.getByText("items.xlsx")).toBeInTheDocument();

		// The X button inside the file display area
		const clearBtn = screen.getAllByRole("button").find(
			(btn) => btn.querySelector("svg") && !btn.textContent?.trim(),
		);
		await userEvent.click(clearBtn!);

		expect(screen.queryByText("items.xlsx")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /import items/i })).toBeDisabled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Import flow
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(draftWorkflowEnabled)("import flow", () => {
	async function selectAndImport(result: {
		imported: number;
		skipped: { row: number; reason: string }[];
		warnings?: { row: number; message: string }[];
	}) {
		mockImport.mockResolvedValue(result);
		renderOpen();

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		await userEvent.upload(input, new File(["data"], "items.xlsx", {
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		}));

		await userEvent.click(screen.getByRole("button", { name: /import items/i }));
		return result;
	}

	it("calls importInventory with the selected file", async () => {
		mockImport.mockResolvedValue({ imported: 1, skipped: [] });
		renderOpen();

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["data"], "items.xlsx", {
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});
		await userEvent.upload(input, file);
		await userEvent.click(screen.getByRole("button", { name: /import items/i }));

		expect(mockImport).toHaveBeenCalledWith(file);
	});

	it("shows successful import count after completion", async () => {
		await selectAndImport({ imported: 4, skipped: [] });

		await waitFor(() => {
			expect(screen.getByText(/4 items imported successfully/i)).toBeInTheDocument();
		});
	});

	it("shows singular 'item' for a count of 1", async () => {
		await selectAndImport({ imported: 1, skipped: [] });

		await waitFor(() => {
			expect(screen.getByText(/1 item imported successfully/i)).toBeInTheDocument();
		});
	});

	it("shows skipped row count and reasons when some rows are skipped", async () => {
		await selectAndImport({
			imported: 2,
			skipped: [{ row: 3, reason: "Missing required field: location" }],
		});

		await waitFor(() => {
			expect(screen.getByText(/1 row skipped/i)).toBeInTheDocument();
			expect(screen.getByText(/Row 3: Missing required field: location/i)).toBeInTheDocument();
		});
	});

	// A coerced unit still produces an item, so it must not read as a skipped row.
	it("reports rows that imported with changes separately from skipped rows", async () => {
		await selectAndImport({
			imported: 2,
			skipped: [],
			warnings: [
				{ row: 2, message: 'Unrecognized unit "widgets" — imported as "each"' },
			],
		});

		await waitFor(() => {
			expect(screen.getByText(/2 items imported successfully/i)).toBeInTheDocument();
			expect(screen.getByText(/1 row imported with changes/i)).toBeInTheDocument();
			expect(screen.getByText(/Row 2: Unrecognized unit "widgets"/i)).toBeInTheDocument();
			expect(screen.queryByText(/skipped/i)).not.toBeInTheDocument();
		});
	});

	// The field postdates the endpoint, so a cached response can arrive without it.
	it("renders a result that carries no warnings array at all", async () => {
		await selectAndImport({ imported: 1, skipped: [] });

		await waitFor(() => {
			expect(screen.getByText(/1 item imported successfully/i)).toBeInTheDocument();
		});
		expect(screen.queryByText(/imported with changes/i)).not.toBeInTheDocument();
	});

	it("shows an error message when the import API call fails", async () => {
		mockImport.mockRejectedValue(new Error("Server error"));
		renderOpen();

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		await userEvent.upload(input, new File(["data"], "items.xlsx", {
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		}));
		await userEvent.click(screen.getByRole("button", { name: /import items/i }));

		await waitFor(() => {
			expect(screen.getByText("Server error")).toBeInTheDocument();
		});
	});

	it("shows 'Done' on the import button after a successful import", async () => {
		await selectAndImport({ imported: 3, skipped: [] });

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
		});
	});

	it("disables the import button after a successful import", async () => {
		await selectAndImport({ imported: 1, skipped: [] });

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /done/i })).toBeDisabled();
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Export and template download
// ─────────────────────────────────────────────────────────────────────────────
describe("export and template", () => {
	it("calls exportLowStockInventory when the export button is clicked", async () => {
		renderOpen();
		await userEvent.click(screen.getByRole("button", { name: /export low stock list/i }));
		expect(mockExportLowStock).toHaveBeenCalled();
	});

	it("calls downloadInventoryTemplate when the template link is clicked", async () => {
		renderOpen();
		await userEvent.click(screen.getByRole("button", { name: /download template/i }));
		expect(mockDownloadTemplate).toHaveBeenCalled();
	});

	it("shows 'Exporting…' while export is in progress", async () => {
		let resolve!: () => void;
		mockExportLowStock.mockReturnValue(new Promise<void>((r) => { resolve = r; }));

		renderOpen();
		fireEvent.click(screen.getByRole("button", { name: /export low stock list/i }));

		await waitFor(() => {
			expect(screen.getByText(/exporting…/i)).toBeInTheDocument();
		});

		resolve();
	});

	it("disables the export button while exporting", async () => {
		let resolve!: () => void;
		mockExportLowStock.mockReturnValue(new Promise<void>((r) => { resolve = r; }));

		renderOpen();
		fireEvent.click(screen.getByRole("button", { name: /export low stock list/i }));

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /exporting/i })).toBeDisabled();
		});

		resolve();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Modal close / state reset
// ─────────────────────────────────────────────────────────────────────────────
describe("modal close", () => {
	it("calls onClose when the X button in the header is clicked", async () => {
		const onClose = vi.fn();
		render(<InventoryImportExport isOpen={true} onClose={onClose} />);

		// The header X button — has no text content and is not the file-clear button
		const headerX = screen.getAllByRole("button").find(
			(btn) => !btn.textContent?.trim() && btn.closest(".fixed"),
		);
		await userEvent.click(headerX!);

		expect(onClose).toHaveBeenCalled();
	});
});
