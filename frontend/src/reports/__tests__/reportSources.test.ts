import { describe, test, expect } from "vitest";
import { REPORT_SOURCES, getReportSource } from "../reportSources";

// Same literal as the keys of REPORT_DEFINITIONS in
// backend/src/lib/reports/reportRegistry.ts. The report builder sends a
// source's id as the `report` key for POST /reports/export/server, so an id
// that isn't a backend key exports nothing. Adding a report to one package
// without the other fails here instead of in production.
const BACKEND_REPORT_KEYS = [
	"jobs",
	"first-time-fix",
	"invoices",
	"clients",
	"inventory",
	"quotes",
	"payments",
	"tax-liability",
	"reorder-forecast",
	"client-retention",
	"client-lifetime-value",
	"aged-receivables-by-client",
	"client-discounts",
	"recurring-revenue",
	"field-added-revenue",
	"revenue-by-line-item-type",
	"revenue-line-items",
	"projects",
] as const;

describe("report sources ↔ backend registry", () => {
	test("source id list matches the cross-package snapshot", () => {
		expect(REPORT_SOURCES.map((s) => s.id)).toEqual([
			"inventory",
			"jobs",
			"invoices",
			"clients",
			"quotes",
			"payments",
			"projects",
		]);
	});

	test("every builder source id is a backend registry key", () => {
		const missing = REPORT_SOURCES.map((s) => s.id).filter(
			(id) => !(BACKEND_REPORT_KEYS as readonly string[]).includes(id),
		);
		expect(missing).toEqual([]);
	});

	test("source ids are unique and resolvable", () => {
		const ids = REPORT_SOURCES.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(getReportSource(id)?.id).toBe(id);
		expect(getReportSource("nope")).toBeUndefined();
	});

	test("every source declares at least one column category with columns", () => {
		for (const s of REPORT_SOURCES) {
			expect(s.categories.length).toBeGreaterThan(0);
			for (const c of s.categories) expect(c.columns.length).toBeGreaterThan(0);
		}
	});
});
