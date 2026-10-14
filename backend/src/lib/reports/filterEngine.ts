export type ReportColumnType = "text" | "number" | "date" | "currency";

export type FilterOperator =
	| "contains"
	| "equals"
	| "gt"
	| "lt"
	| "gte"
	| "lte"
	| "before"
	| "after"
	| "between"
	| "in_last_days"
	| "in"
	| "is_empty"
	| "not_empty";

export type FilterJoin = "and" | "or";

export interface FilterCondition {
	id: string;
	columnKey: string;
	operator: FilterOperator;
	value: string;
	value2?: string;
	valueKind?: "literal" | "field";
	columnType?: ReportColumnType;
}

export type ReportRow = Record<string, unknown>;

export interface PaginateParams {
	search?: string;
	searchTerms?: string[];
	searchKeys?: string[];
	conditions?: FilterCondition[];
	join?: FilterJoin;
	sortKey?: string;
	sortDir?: "asc" | "desc";
	sortType?: ReportColumnType;
	page?: number;
	limit?: number;
}

export interface PaginatedResult<T extends ReportRow> {
	rows: T[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const VALUELESS_OPERATORS: readonly FilterOperator[] = ["is_empty", "not_empty"];

export function normalizeSearchTerms(params: Pick<PaginateParams, "search" | "searchTerms">): string[] {
	return (params.searchTerms ?? (params.search ? [params.search] : []))
		.map((t) => t.trim())
		.filter(Boolean);
}

export function clampPage(params: PaginateParams): {
	limit: number;
	offset: number;
	page: number;
	pageSize: number;
} {
	const rawLimit = Number.isFinite(params.limit) ? Math.floor(params.limit as number) : DEFAULT_LIMIT;
	const pageSize = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
	const page = Math.max(0, Number.isFinite(params.page) ? Math.floor(params.page as number) : 0);
	return { limit: pageSize, offset: page * pageSize, page, pageSize };
}

export function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ""));
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function toTime(value: unknown): number {
	const parsed = new Date(String(value)).getTime();
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function compareValues(a: unknown, b: unknown, type: ReportColumnType): number {
	if (type === "number" || type === "currency") {
		return toNumber(a) - toNumber(b);
	}
	if (type === "date") {
		return toTime(a) - toTime(b);
	}
	return String(a ?? "").localeCompare(String(b ?? ""));
}

function isEmptyCell(cell: unknown): boolean {
	if (cell == null) return true;
	const text = String(cell).trim();
	return text === "" || text === "—";
}

export function isConditionActive(condition: FilterCondition): boolean {
	if (!condition.columnKey) return false;
	if (VALUELESS_OPERATORS.includes(condition.operator)) return true;
	if (condition.operator === "between")
		return condition.value.trim() !== "" && (condition.value2 ?? "").trim() !== "";
	return condition.value.trim() !== "";
}

export function matchesCondition(row: ReportRow, condition: FilterCondition): boolean {
	const type = condition.columnType ?? "text";
	const cell = row[condition.columnKey];
	const isField = condition.valueKind === "field";
	const operand = isField ? row[condition.value] : condition.value;

	if (condition.operator === "is_empty") return isEmptyCell(cell);
	if (condition.operator === "not_empty") return !isEmptyCell(cell);

	if (type === "number" || type === "currency") {
		const target = isField
			? toNumber(operand)
			: parseFloat(condition.value.replace(/[^0-9.-]/g, ""));
		if (!Number.isFinite(target)) return true;
		const cellNum = toNumber(cell);
		if (condition.operator === "gte") return cellNum >= target;
		if (condition.operator === "lte") return cellNum <= target;
		if (condition.operator === "gt") return cellNum > target;
		if (condition.operator === "lt") return cellNum < target;
		return cellNum === target;
	}

	if (type === "date") {
		const cellTime = toTime(cell);
		if (condition.operator === "between") {
			const start = new Date(condition.value).getTime();
			const end = new Date(condition.value2 ?? "").getTime() + DAY_MS - 1;
			if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
			return cellTime >= start && cellTime <= end;
		}
		if (condition.operator === "in_last_days") {
			const days = parseFloat(condition.value);
			if (!Number.isFinite(days)) return true;
			return cellTime >= Date.now() - days * DAY_MS;
		}
		const target = isField ? toTime(operand) : new Date(condition.value).getTime();
		if (!Number.isFinite(target)) return true;
		if (condition.operator === "after") return cellTime > target;
		return cellTime < target;
	}

	const cellText = String(cell ?? "").toLowerCase();
	if (condition.operator === "in") {
		const options = String(operand ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (options.length === 0) return true;
		return options.includes(cellText);
	}
	const target = String(operand ?? "").toLowerCase();
	if (condition.operator === "equals") return cellText === target;
	return cellText.includes(target);
}

export function filterRows<T extends ReportRow>(rows: T[], params: PaginateParams): T[] {
	const terms = normalizeSearchTerms(params).map((t) => t.toLowerCase());
	const activeConditions = (params.conditions ?? []).filter(isConditionActive);
	const join = params.join ?? "and";

	let result = rows.filter((row) => {
		if (terms.length > 0) {
			const keys = params.searchKeys ?? Object.keys(row).filter((k) => k !== "id");
			const matchesAll = terms.every((term) =>
				keys.some((k) => String(row[k] ?? "").toLowerCase().includes(term)),
			);
			if (!matchesAll) return false;
		}
		if (activeConditions.length > 0) {
			const checks = activeConditions.map((c) => matchesCondition(row, c));
			const pass = join === "and" ? checks.every(Boolean) : checks.some(Boolean);
			if (!pass) return false;
		}
		return true;
	});

	if (params.sortKey) {
		const type = params.sortType ?? "text";
		const factor = params.sortDir === "desc" ? -1 : 1;
		const key = params.sortKey;
		result = [...result].sort((a, b) => {
			const cellA = a[key];
			const cellB = b[key];
			const missingA = isEmptyCell(cellA);
			const missingB = isEmptyCell(cellB);
			// Missing/placeholder cells ("—", null, "") always sort last, regardless
			// of direction — otherwise a currency/date column's numeric fallback
			// (toNumber/toTime -> -Infinity) flips which end they land on when the
			// sort direction flips, mixing them in with genuinely low real values.
			if (missingA && missingB) return 0;
			if (missingA) return 1;
			if (missingB) return -1;
			return compareValues(cellA, cellB, type) * factor;
		});
	}

	return result;
}

export function slicePage<T extends ReportRow>(
	filtered: T[],
	params: PaginateParams,
): PaginatedResult<T> {
	const total = filtered.length;
	const { pageSize, page, offset } = clampPage(params);
	return {
		rows: filtered.slice(offset, offset + pageSize),
		total,
		page,
		pageSize,
		hasMore: offset + pageSize < total,
	};
}
