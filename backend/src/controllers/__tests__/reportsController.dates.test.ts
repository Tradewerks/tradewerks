import { describe, it, expect, vi } from "vitest";
import { buildDateFilter, parseReportDate, reportInstant } from "../reportsController.js";
import type { HttpError } from "../../types/responses.js";

// reportsController pulls in the Prisma client at import time; date parsing is
// pure and needs none of it.
vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = { $extends, $queryRaw: vi.fn() };
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

// The frontend sends the user's local range as full ISO instants. Flooring
// those to UTC day bounds would widen every window — for a Denver user "this
// month" (Aug 1 00:00 MDT .. Aug 31 23:59 MDT) becomes Jul 31 18:00 .. Sep 1
// 17:59 local. Instants must be used exactly as sent; only a bare
// YYYY-MM-DD still means "that whole UTC day".
describe("buildDateFilter", () => {
	it("uses full ISO instants exactly as sent (Denver 'this month')", () => {
		const start = "2026-08-01T06:00:00.000Z";
		const end = "2026-09-01T05:59:59.999Z";
		const f = buildDateFilter(start, end);
		expect(f.gte?.toISOString()).toBe(start);
		expect(f.lte?.toISOString()).toBe(end);
	});

	it("uses instants with an explicit offset exactly as sent (Sydney)", () => {
		const f = buildDateFilter("2026-08-01T00:00:00+10:00", "2026-08-31T23:59:59.999+10:00");
		expect(f.gte?.toISOString()).toBe("2026-07-31T14:00:00.000Z");
		expect(f.lte?.toISOString()).toBe("2026-08-31T13:59:59.999Z");
	});

	it("widens a bare YYYY-MM-DD to that whole UTC day", () => {
		const f = buildDateFilter("2026-08-01", "2026-08-01");
		expect(f.gte?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
		expect(f.lte?.toISOString()).toBe("2026-08-01T23:59:59.999Z");
	});

	it("leaves out bounds that were not given", () => {
		expect(buildDateFilter(undefined, undefined)).toEqual({});
		expect(Object.keys(buildDateFilter("2026-08-01", undefined))).toEqual(["gte"]);
		expect(Object.keys(buildDateFilter(undefined, "2026-08-01"))).toEqual(["lte"]);
	});

	it("treats empty strings as absent", () => {
		expect(buildDateFilter("", "")).toEqual({});
	});

	it("rejects unparseable input with a 400, not a 500", () => {
		let caught: HttpError | undefined;
		try {
			buildDateFilter("not-a-date", undefined);
		} catch (e) {
			caught = e as HttpError;
		}
		expect(caught?.statusCode).toBe(400);
		expect(caught?.code).toBe("VALIDATION_ERROR");
		expect(caught?.message).toContain("not-a-date");
	});
});

describe("parseReportDate", () => {
	it("only normalizes the date-only form, per edge", () => {
		expect(parseReportDate("2026-02-10", "start").toISOString()).toBe("2026-02-10T00:00:00.000Z");
		expect(parseReportDate("2026-02-10", "end").toISOString()).toBe("2026-02-10T23:59:59.999Z");
		// An instant is untouched whichever edge it is.
		expect(parseReportDate("2026-02-10T15:30:00.000Z", "start").toISOString()).toBe(
			"2026-02-10T15:30:00.000Z",
		);
		expect(parseReportDate("2026-02-10T15:30:00.000Z", "end").toISOString()).toBe(
			"2026-02-10T15:30:00.000Z",
		);
	});
});

describe("reportInstant", () => {
	it("passes a valid instant through without normalization", () => {
		expect(reportInstant("2026-08-19T15:00:00.000Z").toISOString()).toBe(
			"2026-08-19T15:00:00.000Z",
		);
		// Date-only stays at UTC midnight here — this is the raw, un-widened path.
		expect(reportInstant("2026-08-19").toISOString()).toBe("2026-08-19T00:00:00.000Z");
	});

	it("throws a typed 400 on garbage", () => {
		expect(() => reportInstant("yesterday")).toThrow(/Invalid date/);
		try {
			reportInstant("yesterday");
		} catch (e) {
			expect((e as HttpError).statusCode).toBe(400);
		}
	});
});
