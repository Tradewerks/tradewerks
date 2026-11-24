const { sdb } = vi.hoisted(() => ({
	sdb: {
		organization: {
			findUnique: vi.fn(async () => ({
				qb_access_token: "tok",
				qb_refresh_token: "ref",
				qb_realm_id: "realm1",
				qb_token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
			})),
		},
	},
}));

vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qbFetch } from "../quickbooksService.js";
import { QbHttpError } from "../qb/qbHttpError.js";

describe("qbFetch", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("qbFetch appends requestid when given and omits it otherwise", async () => {
		await qbFetch("org1", "POST", "/payment", { a: 1 }, { requestId: "pay-p1-abc/12" });
		await qbFetch("org1", "POST", "/payment?operation=delete", { a: 1 }, { requestId: "r2" });
		await qbFetch("org1", "POST", "/payment", { a: 1 });
		await qbFetch("org1", "GET", "/payment/9", undefined, { requestId: "ignored" });

		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls[0]).toMatch(
			/\/v3\/company\/realm1\/payment\?minorversion=75&requestid=pay-p1-abc%2F12$/,
		);
		expect(urls[1]).toMatch(
			/\/payment\?operation=delete&minorversion=75&requestid=r2$/,
		);
		expect(urls[2]).toMatch(/\/payment\?minorversion=75$/);
		expect(urls[2]).not.toContain("requestid");
		expect(urls[3]).not.toContain("requestid");
	});

	it("qbFetch throws a QbHttpError carrying the status on a non-2xx response", async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad" });

		const err = await qbFetch("org1", "POST", "/payment", {}).catch((e) => e);

		expect(err).toBeInstanceOf(QbHttpError);
		expect(err).toBeInstanceOf(Error);
		expect(err.status).toBe(400);
		expect(err.message).toBe("QB POST /payment → 400: bad");
	});
});
