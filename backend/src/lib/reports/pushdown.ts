import {
	clampPage,
	isConditionActive,
	normalizeSearchTerms,
	toNumber,
	DAY_MS,
	type FilterCondition,
	type PaginateParams,
	type ReportColumnType,
} from "./filterEngine.js";

//Maps a column key to SQL
export interface ColumnDef {
	expr: string;
	type: ReportColumnType;
	filterable: boolean;
	sortable: boolean;
	searchable: boolean;
}

export type ColumnMap = Record<string, ColumnDef>;

export interface DefaultOrder {
	expr: string;
	dir: "asc" | "desc";
}

export interface SqlParts {
	whereSql: string; // "" when no active filters
	whereParams: unknown[];
	orderSql: string;
	limit: number;
	offset: number;
	page: number;
	pageSize: number;
}

const isValidDate = (d: Date): boolean => !Number.isNaN(d.getTime());

class Params {
	private readonly values: unknown[] = [];
	constructor(private readonly base: number) {}
	bind(value: unknown): string {
		this.values.push(value);
		return `$${this.base + this.values.length}`;
	}
	dynamic(): unknown[] {
		return this.values;
	}
}

function conditionSql(cond: FilterCondition, col: ColumnDef, p: Params): string | null {
	if (cond.valueKind === "field") return null; // column-vs-column not supported
	const E = col.expr;
	const op = cond.operator;
	const type = col.type;

	if (op === "is_empty" || op === "not_empty") {
		if (type === "text") {
			return op === "is_empty"
				? `(${E} IS NULL OR ${E} = '')`
				: `(${E} IS NOT NULL AND ${E} <> '')`;
		}
		return op === "is_empty" ? `${E} IS NULL` : `${E} IS NOT NULL`;
	}

	if (type === "number" || type === "currency") {
		const n = toNumber(cond.value);
		if (!Number.isFinite(n)) return null;
		switch (op) {
			case "gt":
				return `${E} > ${p.bind(n)}`;
			case "gte":
				return `${E} >= ${p.bind(n)}`;
			case "lt":
				return `${E} < ${p.bind(n)}`;
			case "lte":
				return `${E} <= ${p.bind(n)}`;
			case "equals":
				return `${E} = ${p.bind(n)}`;
			case "between": {
				const n2 = toNumber(cond.value2 ?? "");
				if (!Number.isFinite(n2)) return null;
				return `${E} BETWEEN ${p.bind(n)} AND ${p.bind(n2)}`;
			}
			case "in": {
				const opts = cond.value
					.split(",")
					.map((s) => toNumber(s))
					.filter((v) => Number.isFinite(v));
				return `${E} = ANY(${p.bind(opts)})`;
			}
			default:
				return null;
		}
	}

	if (type === "date") {
		switch (op) {
			case "before": {
				const d = new Date(cond.value);
				return isValidDate(d) ? `${E} < ${p.bind(d)}` : null;
			}
			case "after": {
				const d = new Date(cond.value);
				return isValidDate(d) ? `${E} > ${p.bind(d)}` : null;
			}
			case "between": {
				const s = new Date(cond.value);
				const e = new Date(cond.value2 ?? "");
				if (!isValidDate(s) || !isValidDate(e)) return null;
				e.setTime(e.getTime() + DAY_MS - 1);
				return `${E} BETWEEN ${p.bind(s)} AND ${p.bind(e)}`;
			}
			case "in_last_days": {
				const days = parseFloat(cond.value);
				if (!Number.isFinite(days)) return null;
				return `${E} >= ${p.bind(new Date(Date.now() - days * DAY_MS))}`;
			}
			default:
				return null;
		}
	}

	// text (regular columns and enum-as-::text)
	switch (op) {
		case "contains":
			return `${E} ILIKE ${p.bind(`%${cond.value}%`)}`;
		case "equals":
			return `${E} ILIKE ${p.bind(cond.value)}`;
		case "in": {
			const opts = cond.value
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			return `LOWER(${E}) = ANY(${p.bind(opts)})`;
		}
		default:
			return null;
	}
}

function buildWhereSql(
	params: PaginateParams,
	columns: ColumnMap,
	p: Params,
): { sql: string } | null {
	const clauses: string[] = [];

	const active = (params.conditions ?? []).filter(isConditionActive);
	const parts: string[] = [];
	for (const c of active) {
		const col = columns[c.columnKey];
		if (!col || !col.filterable) return null;
		const frag = conditionSql(c, col, p);
		if (frag === null) return null;
		parts.push(frag);
	}
	if (parts.length) {
		const join = params.join === "or" ? " OR " : " AND ";
		clauses.push(`(${parts.join(join)})`);
	}

	const terms = normalizeSearchTerms(params);
	if (terms.length) {
		const searchable = Object.values(columns).filter((c) => c.searchable);
		if (searchable.length === 0) return null;
		for (const term of terms) {
			const ors = searchable.map((c) => `${c.expr} ILIKE ${p.bind(`%${term}%`)}`);
			clauses.push(`(${ors.join(" OR ")})`);
		}
	}

	return { sql: clauses.join(" AND ") };
}

function buildOrderSql(
	params: PaginateParams,
	columns: ColumnMap,
	defaultOrder: DefaultOrder,
	idExpr: string,
): string | null {
	if (params.sortKey) {
		const col = columns[params.sortKey];
		if (!col || !col.sortable) return null;
		const dir = params.sortDir === "desc" ? "DESC" : "ASC";
		return `${col.expr} ${dir} NULLS LAST, ${idExpr} ASC`;
	}
	const dir = defaultOrder.dir === "desc" ? "DESC" : "ASC";
	return `${defaultOrder.expr} ${dir} NULLS LAST, ${idExpr} ASC`;
}

export function buildSqlParts(
	params: PaginateParams,
	columns: ColumnMap,
	opts: { defaultOrder: DefaultOrder; idExpr: string; paramOffset: number },
): SqlParts | null {
	const p = new Params(opts.paramOffset);
	const where = buildWhereSql(params, columns, p);
	if (!where) return null;
	const orderSql = buildOrderSql(params, columns, opts.defaultOrder, opts.idExpr);
	if (!orderSql) return null;
	const { limit, offset, page, pageSize } = clampPage(params);
	return {
		whereSql: where.sql,
		whereParams: p.dynamic(),
		orderSql,
		limit,
		offset,
		page,
		pageSize,
	};
}
