import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseSpreadsheet } from "../spreadsheetParser.js";

function workbookBuffer(sheets: Record<string, unknown[][]>): Buffer {
	const workbook = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) {
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
	}
	return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

describe("parseSpreadsheet", () => {
	it("extracts every non-empty worksheet with sheet and physical row provenance", () => {
		const result = parseSpreadsheet(workbookBuffer({
			Warehouse: [["name", "location", "quantity"], ["Filter", "A1", 4]],
			Empty: [[], []],
			Truck: [["sku", "name", "location"], ["CAP-1", "Capacitor", "Van", 2]],
		}));
		expect(result.rows).toHaveLength(2);
		expect(result.rows.map((row) => [row.sheetName, row.rowNumber])).toEqual([["Warehouse", 2], ["Truck", 2]]);
		expect(result.metadata).toMatchObject({ sheetCount: 3, nonEmptySheetCount: 2, rowCount: 2 });
	});

	it("detects headerless tables and maps the template column order", () => {
		const result = parseSpreadsheet(workbookBuffer({ Sheet1: [["Filter", "Pleated", "A1", 10]] }));
		expect(result.metadata.headerlessSheets).toEqual(["Sheet1"]);
		expect(result.rows[0].raw).toMatchObject({ name: "Filter", description: "Pleated", location: "A1", quantity: "10" });
		expect(result.rows[0].rowNumber).toBe(1);
	});

	it("skips repeated header rows without losing later data", () => {
		const result = parseSpreadsheet(workbookBuffer({
			Sheet1: [["name", "location"], ["Filter", "A1"], ["name", "location"], ["Motor", "B2"]],
		}));
		expect(result.rows.map((row) => row.raw.name)).toEqual(["Filter", "Motor"]);
		expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 4]);
	});

	it("rejects an empty file with an actionable code", () => {
		expect(() => parseSpreadsheet(Buffer.alloc(0))).toThrow("spreadsheet is empty");
	});
});
