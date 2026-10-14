import { DEFAULT_UNIT_CODE, normalizeUnitCode } from "../../lib/units.js";
import { isStorableStockQty } from "../../lib/validate/shared.js";
import {
	FINANCIAL_FIELDS,
	type FinancialField,
	type InventoryProposal,
	type MappedInventoryRow,
	type NormalizedInventoryRow,
} from "./types.js";

function clean(value: unknown): string {
	return String(value ?? "").trim().replace(/\s+/g, " ");
}

function nullable(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	const normalized = clean(value);
	return normalized ? normalized : null;
}

function parseNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const raw = clean(value);
	if (!raw) return undefined;
	const negative = /^\(.*\)$/.test(raw);
	const numeric = Number(raw.replace(/[,$%()\s]/g, ""));
	return Number.isFinite(numeric) ? (negative ? -numeric : numeric) : undefined;
}

function decimalPlaces(value: number): number {
	const normalized = value.toString().toLowerCase();
	if (normalized.includes("e-")) return Number(normalized.split("e-")[1]);
	return normalized.includes(".") ? normalized.split(".")[1].length : 0;
}

function parseList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	const values = Array.isArray(value) ? value : clean(value).split(/[,;|]/);
	return [...new Set(values.map(clean).filter(Boolean))];
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	const folded = clean(value).toLowerCase();
	if (["true", "yes", "y", "1"].includes(folded)) return true;
	if (["false", "no", "n", "0"].includes(folded)) return false;
	return undefined;
}

export function normalizeInventoryRow(mapped: MappedInventoryRow): NormalizedInventoryRow {
	const source = mapped.proposal;
	const proposal: InventoryProposal = {};
	const issues: NormalizedInventoryRow["issues"] = [];

	proposal.name = clean(source.name);
	proposal.location = clean(source.location);
	proposal.description = clean(source.description);
	proposal.sku = nullable(source.sku)?.toUpperCase() ?? nullable(source.sku);
	proposal.barcode = nullable(source.barcode)?.replace(/\s+/g, "") ?? nullable(source.barcode);
	proposal.category = nullable(source.category);
	proposal.manufacturer = nullable(source.manufacturer);
	proposal.model = nullable(source.model);
	proposal.external_id = nullable(source.external_id);
	proposal.source_namespace = nullable(source.source_namespace);
	proposal.lot_number = nullable(source.lot_number);
	proposal.variant_group_name = nullable(source.variant_group_name);
	proposal.alt_ids = parseList(source.alt_ids)?.map((value) => value.toUpperCase());
	proposal.tags = parseList(source.tags);
	proposal.serial_numbers = parseList(source.serial_numbers);
	proposal.is_serialized = parseBoolean(source.is_serialized) ?? false;
	proposal.is_batch_tracked = parseBoolean(source.is_batch_tracked) ?? false;

	const rawUnit = clean(source.unit);
	const unit = rawUnit ? normalizeUnitCode(rawUnit) : DEFAULT_UNIT_CODE;
	proposal.unit = unit ?? rawUnit;
	if (rawUnit && !unit) {
		issues.push({ field: "unit", code: "UNKNOWN_UNIT", message: `Unit '${rawUnit}' is not recognized` });
	}

	const quantity = source.quantity == null ? undefined : parseNumber(source.quantity);
	if (source.quantity != null && quantity === undefined) {
		issues.push({ field: "quantity", code: "INVALID_NUMBER", message: "Quantity is not a valid number" });
	} else if (quantity !== undefined) {
		proposal.quantity = quantity;
		if (quantity < 0) issues.push({ field: "quantity", code: "NEGATIVE", message: "Quantity cannot be negative" });
		if (!isStorableStockQty(quantity)) {
			issues.push({ field: "quantity", code: "INVALID_PRECISION", message: "Quantity must fit numeric(10,2)" });
		}
	}

	for (const field of ["cost", "unit_price", "cost_at_receipt"] as const) {
		if (source[field] === null) {
			proposal[field] = null;
			continue;
		}
		const value = parseNumber(source[field]);
		if (source[field] !== undefined && value === undefined) {
			issues.push({ field, code: "INVALID_NUMBER", message: `${field} is not a valid amount` });
		} else if (value !== undefined) {
			proposal[field] = value;
			if (value < 0) issues.push({ field, code: "NEGATIVE", message: `${field} cannot be negative` });
			if (decimalPlaces(value) > 2 || value >= 100_000_000) {
				issues.push({ field, code: "INVALID_PRECISION", message: `${field} must fit numeric(10,2)` });
			}
		}
	}

	const threshold = source.low_stock_threshold === null ? undefined : parseNumber(source.low_stock_threshold);
	if (source.low_stock_threshold === null) {
		proposal.low_stock_threshold = null;
	} else if (source.low_stock_threshold !== undefined && threshold === undefined) {
		issues.push({ field: "low_stock_threshold", code: "INVALID_NUMBER", message: "Low stock threshold is not a valid number" });
	} else if (threshold !== undefined) {
		proposal.low_stock_threshold = threshold;
		if (threshold < 0 || !isStorableStockQty(threshold)) {
			issues.push({ field: "low_stock_threshold", code: "INVALID_PRECISION", message: "Low stock threshold must be a non-negative numeric(10,2) value" });
		}
	}

	if (!proposal.name) issues.push({ field: "name", code: "REQUIRED", message: "Name is required" });
	if (!proposal.location) issues.push({ field: "location", code: "REQUIRED", message: "Location is required" });
	if ((proposal.is_serialized || proposal.is_batch_tracked) && (proposal.quantity ?? 0) > 0) {
		if (proposal.is_serialized && (proposal.serial_numbers?.length ?? 0) !== proposal.quantity) {
			issues.push({ field: "serial_numbers", code: "TRACKING_REQUIRED", message: "Tracked quantity requires one serial number per unit" });
		}
		if (proposal.is_batch_tracked && !proposal.lot_number) {
			issues.push({ field: "lot_number", code: "TRACKING_REQUIRED", message: "Batch-tracked quantity requires a lot number" });
		}
	}

	const financialFields = FINANCIAL_FIELDS.filter((field) => source[field] !== undefined) as FinancialField[];
	const lowConfidence = Object.values(mapped.fieldConfidence).some((confidence) => confidence < 0.75);
	return { proposal, issues, financialFields, lowConfidence };
}
