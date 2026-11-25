import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import {
	ListQueryError,
	markLegacyList,
	isPagedRequest,
	parseListQuery,
	sendList,
	sendListError,
	type ListSpec,
} from "../listQuery.js";

const spec: ListSpec<"created_at" | "title", "Draft" | "Sent" | "Viewed"> = {
	sortable: ["created_at", "title"],
	defaultSort: "created_at",
	defaultDir: "desc",
	statuses: ["Draft", "Sent", "Viewed"],
};

function caught(fn: () => unknown): ListQueryError {
	try {
		fn();
	} catch (e) {
		return e as ListQueryError;
	}
	throw new Error("expected parseListQuery to throw");
}

function fakeRes() {
	const res = {
		headers: {} as Record<string, string>,
		body: undefined as unknown,
		code: 200,
		status: vi.fn((c: number) => {
			res.code = c;
			return res;
		}),
		setHeader: vi.fn((k: string, v: string) => {
			res.headers[k] = v;
		}),
		json: vi.fn((b: unknown) => {
			res.body = b;
		}),
	};
	return res;
}

describe("parseListQuery", () => {
	it("defaults to page 1, limit 50, the spec's default sort", () => {
		const p = parseListQuery({ page: "" }, spec);
		expect(p).toMatchObject({
			paged: true,
			page: 1,
			take: 50,
			skip: 0,
			sort: "created_at",
			dir: "desc",
		});
		expect(p.q).toBeUndefined();
		expect(p.status).toBeUndefined();
	});

	it("rejects limit 500 and an unknown sort field with 400", () => {
		const limit = caught(() =>
			parseListQuery({ page: "1", limit: "500" }, spec),
		);
		expect(limit).toBeInstanceOf(ListQueryError);
		expect(limit.statusCode).toBe(400);
		expect(limit.code).toBe("INVALID_INPUT");
		expect(limit.field).toBe("limit");

		const sort = caught(() =>
			parseListQuery({ page: "1", sort: "password" }, spec),
		);
		expect(sort).toBeInstanceOf(ListQueryError);
		expect(sort.statusCode).toBe(400);
		expect(sort.field).toBe("sort");
	});

	it("rejects a status not in the spec", () => {
		expect(parseListQuery({ page: "1", status: "Sent,Viewed" }, spec).status).toEqual([
			"Sent",
			"Viewed",
		]);
		const e = caught(() => parseListQuery({ page: "1", status: "Sent,Paid" }, spec));
		expect(e).toBeInstanceOf(ListQueryError);
		expect(e.field).toBe("status");
	});

	it("rejects a page whose offset overflows with 400", () => {
		const e = caught(() =>
			parseListQuery({ page: "99999999999", limit: "50" }, spec),
		);
		expect(e).toBeInstanceOf(ListQueryError);
		expect(e.statusCode).toBe(400);
		expect(e.field).toBe("page");
		// The largest offset that still fits Prisma's int32 skip is accepted.
		expect(
			parseListQuery({ page: "2147483648", limit: "1" }, spec).skip,
		).toBe(2_147_483_647);
	});

	it("paged is false when page is absent", () => {
		expect(parseListQuery({}, spec).paged).toBe(false);
		expect(parseListQuery({ limit: "10" }, spec).paged).toBe(false);
	});

	it("computes skip from a 1-based page and ignores a one-char search", () => {
		const p = parseListQuery(
			{ page: "3", limit: "20", q: " a ", dir: "asc" },
			spec,
		);
		expect(p.skip).toBe(40);
		expect(p.take).toBe(20);
		expect(p.dir).toBe("asc");
		expect(p.q).toBeUndefined();
		expect(parseListQuery({ page: "1", q: "  ab " }, spec).q).toBe("ab");
	});

	it("rejects page 0, a bad date, and from after to", () => {
		expect(caught(() => parseListQuery({ page: "0" }, spec)).field).toBe(
			"page",
		);
		expect(caught(() => parseListQuery({ page: "1", from: "nope" }, spec)).field).toBe(
			"from",
		);
		expect(
			caught(() =>
				parseListQuery({ page: "1", from: "2026-02-01", to: "2026-01-01" }, spec),
			).field,
		).toBe("to");
		const ok = parseListQuery(
			{ page: "1", from: "2026-01-01", to: "2026-02-01" },
			spec,
		);
		expect(ok.from?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	it("date-only to is exclusive of the next day", () => {
		const p = parseListQuery({ page: "1", from: "2026-11-24", to: "2026-11-24" }, spec);
		expect(p.from?.toISOString()).toBe("2026-11-24T00:00:00.000Z");
		expect(p.to?.toISOString()).toBe("2026-11-25T00:00:00.000Z");
		expect(
			parseListQuery({ page: "1", to: "2026-12-31" }, spec).to?.toISOString(),
		).toBe("2027-01-01T00:00:00.000Z");
	});

	it("rejects a date-only to that is a day before from", () => {
		expect(
			caught(() =>
				parseListQuery({ page: "1", from: "2026-11-25", to: "2026-11-24" }, spec),
			).field,
		).toBe("to");
	});

	it("a legacy call (no page) skips validation and returns defaults", () => {
		const p = parseListQuery({ sort: "desc", limit: "500", q: "x" }, spec);
		expect(p.paged).toBe(false);
		expect(p.sort).toBe(spec.defaultSort);
		expect(isPagedRequest({ sort: "desc" })).toBe(false);
		expect(isPagedRequest({ page: "" })).toBe(true);
	});

	it("a full ISO to is kept as the exclusive bound", () => {
		const p = parseListQuery({ page: "1", to: "2026-11-24T10:00:00Z" }, spec);
		expect(p.to?.toISOString()).toBe("2026-11-24T10:00:00.000Z");
	});
});

describe("sendList / markLegacyList", () => {
	it("puts total in meta.count with page and limit", () => {
		const res = fakeRes();
		const p = parseListQuery({ page: "2", limit: "10" }, spec);
		sendList(res as unknown as Response, p, [{ id: 1 }], 11);
		expect(res.body).toMatchObject({
			success: true,
			data: [{ id: 1 }],
			error: null,
			meta: { count: 11, page: 2, limit: 10 },
		});
	});

	it("sends the bare array plus deprecation headers when not paged", () => {
		const res = fakeRes();
		const p = parseListQuery({}, spec);
		sendList(res as unknown as Response, p, [{ id: 1 }], 1);
		expect(res.body).toMatchObject({ success: true, data: [{ id: 1 }] });
		expect(
			(res.body as { meta: Record<string, unknown> }).meta.page,
		).toBeUndefined();
		expect(res.headers.Deprecation).toBe("true");

		const legacy = fakeRes();
		markLegacyList(legacy as unknown as Response);
		expect(legacy.headers.Deprecation).toBe("true");
		expect(legacy.headers.Link).toBe('<?page=1>; rel="successor-version"');
	});

	it("points the successor link at the same path with its filters kept", () => {
		const res = Object.assign(fakeRes(), {
			req: { originalUrl: "/quotes?status=Sent" },
		});
		markLegacyList(res as unknown as Response);
		expect(res.headers.Link).toBe(
			'</quotes?status=Sent&page=1>; rel="successor-version"',
		);
	});
});

describe("sendListError", () => {
	it("answers a ListQueryError with 400 and keeps the field", () => {
		const res = fakeRes();
		const err = caught(() => parseListQuery({ page: "1", sort: "nope" }, spec));
		expect(sendListError(res as unknown as Response, err)).toBe(true);
		expect(res.code).toBe(400);
		expect(res.body).toMatchObject({
			success: false,
			data: null,
			error: { code: "INVALID_INPUT", field: "sort" },
		});
	});

	it("leaves any other error to the caller", () => {
		const res = fakeRes();
		expect(sendListError(res as unknown as Response, new Error("db"))).toBe(
			false,
		);
		expect(res.status).not.toHaveBeenCalled();
		expect(res.json).not.toHaveBeenCalled();
	});
});
