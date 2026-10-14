import * as XLSX from "xlsx";
import { InventoryImportError, type ExtractedInventoryRow } from "./types.js";

const KNOWN_HEADERS = new Set([
	"name", "name*", "product", "item", "description", "location", "location*", "warehouse",
	"quantity", "qty", "on hand", "unit", "uom", "unit price", "price", "cost", "sku",
	"barcode", "upc", "category", "manufacturer", "model", "tags", "alternate id", "external id",
]);

const DEFAULT_POSITIONAL_HEADERS = [
	"name", "description", "location", "quantity", "unit", "unit_price", "cost", "sku",
	"barcode", "category", "low_stock_threshold", "tags", "external_id",
];

function nonEmpty(row: unknown[]): boolean {
	return row.some((value) => String(value ?? "").trim() !== "");
}

function canonicalHeader(value: unknown): string {
	return String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function uniqueHeaders(row: unknown[]): string[] {
	const seen = new Map<string, number>();
	return row.map((value, index) => {
		const base = String(value ?? "").trim() || `column_${index + 1}`;
		const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
		seen.set(base.toLowerCase(), count);
		return count === 1 ? base : `${base}_${count}`;
	});
}

function looksLikeHeader(row: unknown[]): boolean {
	const cells = row.map(canonicalHeader).filter(Boolean);
	if (cells.length === 0) return false;
	const known = cells.filter((cell) => KNOWN_HEADERS.has(cell)).length;
	return known >= 1 && known / cells.length >= 0.2;
}

function isRepeatedHeader(row: unknown[], headers: string[]): boolean {
	const left = row.slice(0, headers.length).map(canonicalHeader);
	const right = headers.map(canonicalHeader);
	const populated = right.filter(Boolean).length;
	return populated > 0 && left.filter((value, index) => value && value === right[index]).length / populated >= 0.8;
}

export interface SpreadsheetParseResult {
	rows: ExtractedInventoryRow[];
	metadata: { sheetCount: number; nonEmptySheetCount: number; rowCount: number; headerlessSheets: string[] };
}

export function parseSpreadsheet(buffer: Buffer): SpreadsheetParseResult {
	const maxBytes = Number(process.env.INVENTORY_IMPORT_MAX_FILE_BYTES ?? 10 * 1024 * 1024);
	const maxRows = Number(process.env.INVENTORY_IMPORT_MAX_ROWS ?? 10_000);
	if (buffer.byteLength === 0) {
		throw new InventoryImportError("The uploaded spreadsheet is empty", "EMPTY_FILE", 422);
	}
	if (buffer.byteLength > maxBytes) {
		throw new InventoryImportError(`File exceeds the ${maxBytes} byte import limit`, "FILE_TOO_LARGE", 413);
	}

	let workbook: XLSX.WorkBook;
	try {
		workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
	} catch {
		throw new InventoryImportError("The spreadsheet could not be parsed", "MALFORMED_SPREADSHEET", 422);
	}

	const extracted: ExtractedInventoryRow[] = [];
	const headerlessSheets: string[] = [];
	let nonEmptySheetCount = 0;

	for (const sheetName of workbook.SheetNames) {
		const sheet = workbook.Sheets[sheetName];
		const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
			header: 1,
			defval: "",
			raw: false,
		});
		const firstIndex = matrix.findIndex(nonEmpty);
		if (firstIndex < 0) continue;
		nonEmptySheetCount += 1;

		const first = matrix[firstIndex];
		const hasHeader = looksLikeHeader(first);
		const width = Math.max(...matrix.filter(nonEmpty).map((row) => row.length));
		const headers = hasHeader
			? uniqueHeaders([...first, ...Array(Math.max(0, width - first.length)).fill("")])
			: Array.from({ length: width }, (_, index) => DEFAULT_POSITIONAL_HEADERS[index] ?? `column_${index + 1}`);
		if (!hasHeader) headerlessSheets.push(sheetName);
		const start = hasHeader ? firstIndex + 1 : firstIndex;

		for (let index = start; index < matrix.length; index += 1) {
			const row = matrix[index];
			if (!nonEmpty(row) || isRepeatedHeader(row, headers)) continue;
			const raw: Record<string, unknown> = {};
			for (let column = 0; column < headers.length; column += 1) {
				raw[headers[column]] = row[column] ?? "";
			}
			extracted.push({
				sheetName,
				rowNumber: index + 1,
				raw,
				originalHeaders: headers,
			});
			if (extracted.length > maxRows) {
				throw new InventoryImportError(`Import exceeds the ${maxRows} row limit`, "ROW_LIMIT_EXCEEDED", 422);
			}
		}
	}

	if (extracted.length === 0) {
		throw new InventoryImportError("No inventory rows were found in the spreadsheet", "EMPTY_FILE", 422);
	}

	return {
		rows: extracted,
		metadata: {
			sheetCount: workbook.SheetNames.length,
			nonEmptySheetCount,
			rowCount: extracted.length,
			headerlessSheets,
		},
	};
}
