import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
	process.env.PUBLIC_LINK_SECRET = "s".repeat(40);
	process.env.FRONTEND_URL = "https://app.test";
	const link = {
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	};
	return { link };
});

vi.mock("../../db.js", () => ({ db: { public_link: h.link } }));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../context.js", () => ({
	getScopedDb: () => ({ public_link: h.link }),
}));

import {
	extendVisitLinks,
	issueLink,
	linkExpiry,
	publicUrlWarning,
	resolveLink,
	unsubscribeHeaders,
} from "../publicLink.js";
import { hashInviteToken } from "../inviteToken.js";

const P = { purpose: "unsubscribe" as const, entityId: "c1", contactId: "c1" };

beforeEach(() => {
	vi.clearAllMocks();
	h.link.findFirst.mockResolvedValue(null);
	h.link.create.mockImplementation(async ({ data }) => ({
		id: "l1",
		...data,
	}));
	h.link.update.mockImplementation(async ({ data }) => ({
		id: "l1",
		...data,
	}));
	h.link.updateMany.mockResolvedValue({ count: 1 });
});

describe("issueLink", () => {
	it("only the sha256 hash is stored", async () => {
		const { token, url } = await issueLink("org-1", P);
		const data = h.link.create.mock.calls[0][0].data;
		expect(data.token_hash).toBe(hashInviteToken(token));
		expect(JSON.stringify(data)).not.toContain(token);
		expect(url).toBe(`https://app.test/app/c/${token}`);
	});

	it("issueLink returns the same token for the same org, purpose, entity and contact", async () => {
		const a = await issueLink("org-1", P);
		const b = await issueLink("org-1", P);
		const other = await issueLink("org-2", P);
		const otherEntity = await issueLink("org-1", { ...P, entityId: "c2" });
		expect(b.token).toBe(a.token);
		expect(other.token).not.toBe(a.token);
		expect(otherEntity.token).not.toBe(a.token);
	});

	it("extends an existing link's expiry to the later date, and null wins", async () => {
		const early = new Date("2030-01-01");
		const late = new Date("2031-01-01");
		h.link.findFirst.mockResolvedValue({
			id: "l1",
			expires_at: late,
			revoked_at: null,
		});
		await issueLink("org-1", { ...P, expiresAt: early });
		expect(h.link.update).not.toHaveBeenCalled();

		h.link.findFirst.mockResolvedValue({
			id: "l1",
			expires_at: early,
			revoked_at: null,
		});
		await issueLink("org-1", { ...P, expiresAt: late });
		expect(h.link.update.mock.calls[0][0].data).toEqual({
			expires_at: late,
		});

		h.link.update.mockClear();
		await issueLink("org-1", { ...P, expiresAt: null });
		expect(h.link.update.mock.calls[0][0].data).toEqual({
			expires_at: null,
		});
	});

	it("issues a fresh random token when the deterministic link was revoked", async () => {
		const first = await issueLink("org-1", P);
		h.link.findFirst.mockResolvedValueOnce({
			id: "l1",
			expires_at: null,
			revoked_at: new Date(),
		});
		const again = await issueLink("org-1", P);
		expect(again.token).not.toBe(first.token);
		expect(h.link.create.mock.calls.at(-1)![0].data.token_hash).toBe(
			hashInviteToken(again.token),
		);
	});

	it("refuses to issue without PUBLIC_LINK_SECRET", async () => {
		const saved = process.env.PUBLIC_LINK_SECRET;
		delete process.env.PUBLIC_LINK_SECRET;
		await expect(issueLink("org-1", P)).rejects.toThrow(
			/PUBLIC_LINK_SECRET/,
		);
		process.env.PUBLIC_LINK_SECRET = saved;
	});
});

describe("resolveLink", () => {
	const row = (over: Record<string, unknown> = {}) => ({
		id: "l1",
		organization_id: "org-1",
		purpose: "unsubscribe",
		entity_id: "c1",
		contact_id: "c1",
		expires_at: null,
		revoked_at: null,
		first_used_at: null,
		...over,
	});

	it("resolveLink returns null for an expired, revoked or unknown token and never throws", async () => {
		h.link.findUnique.mockResolvedValueOnce(null);
		expect(await resolveLink("nope")).toBeNull();
		h.link.findUnique.mockResolvedValueOnce(
			row({ revoked_at: new Date() }),
		);
		expect(await resolveLink("t")).toBeNull();
		h.link.findUnique.mockResolvedValueOnce(
			row({ expires_at: new Date(Date.now() - 1000) }),
		);
		expect(await resolveLink("t")).toBeNull();
		h.link.findUnique.mockRejectedValueOnce(new Error("db down"));
		expect(await resolveLink("t")).toBeNull();
		expect(await resolveLink("")).toBeNull();
	});

	it("looks up by hash, returns the link and stamps first_used_at once", async () => {
		h.link.findUnique.mockResolvedValue(row());
		const out = await resolveLink("tok");
		expect(h.link.findUnique).toHaveBeenCalledWith({
			where: { token_hash: hashInviteToken("tok") },
		});
		expect(out).toEqual({
			id: "l1",
			organization_id: "org-1",
			purpose: "unsubscribe",
			entity_id: "c1",
			contact_id: "c1",
		});
		expect(h.link.updateMany).toHaveBeenCalledWith({
			where: { id: "l1", first_used_at: null },
			data: { first_used_at: expect.any(Date) },
		});
	});

	it("still resolves when stamping first_used_at fails", async () => {
		h.link.findUnique.mockResolvedValue(row());
		h.link.updateMany.mockRejectedValue(new Error("write failed"));
		expect(await resolveLink("tok")).toMatchObject({ id: "l1" });
	});
});

describe("linkExpiry", () => {
	it("gives each purpose its lifetime", () => {
		const now = new Date("2026-11-21T12:00:00Z");
		const created = new Date("2026-11-01T00:00:00Z");
		const exp = new Date("2026-12-01T00:00:00Z");
		const valid = new Date("2026-12-15T00:00:00Z");
		const end = new Date("2026-11-25T18:00:00Z");
		expect(
			linkExpiry("quote", { expires_at: exp, valid_until: valid }, now),
		).toEqual(exp);
		expect(linkExpiry("quote", { valid_until: valid }, now)).toEqual(
			new Date("2026-12-16T00:00:00Z"),
		);
		expect(linkExpiry("quote", { created_at: created }, now)).toEqual(
			new Date("2026-12-31T00:00:00Z"),
		);
		expect(linkExpiry("invoice", {}, now)).toEqual(
			new Date("2027-05-20T12:00:00Z"),
		);
		expect(linkExpiry("visit", { scheduled_end_at: end }, now)).toEqual(
			new Date("2026-11-26T18:00:00Z"),
		);
		expect(linkExpiry("unsubscribe", {}, now)).toBeNull();
	});

	it("a quote valid until Nov 20 keeps its link through Nov 20 23:59 org-local", () => {
		const now = new Date("2026-11-10T12:00:00Z");
		// The dispatcher picked Nov 20; stored as Chicago midnight.
		const valid = new Date("2026-11-20T06:00:00Z");
		const exp = linkExpiry(
			"quote",
			{ valid_until: valid, timezone: "America/Chicago" },
			now,
		)!;
		expect(exp).toEqual(new Date("2026-11-21T06:00:00Z"));
		expect(exp > new Date("2026-11-21T05:59:00Z")).toBe(true);
	});

	it("a completed visit's link lasts 30 days after completion", () => {
		const now = new Date("2026-11-21T12:00:00Z");
		const end = new Date("2026-11-20T18:00:00Z");
		const done = new Date("2026-11-20T17:10:00Z");
		expect(
			linkExpiry(
				"visit",
				{
					scheduled_end_at: end,
					status: "Completed",
					actual_end_at: done,
				},
				now,
			),
		).toEqual(new Date("2026-12-20T17:10:00Z"));
		expect(
			linkExpiry(
				"visit",
				{ scheduled_end_at: end, status: "Completed" },
				now,
			),
		).toEqual(new Date("2026-12-21T12:00:00Z"));
	});
});

describe("extendVisitLinks", () => {
	it("extends only links that are still live, never resurrecting an expired one", async () => {
		const now = new Date("2026-11-21T12:00:00Z");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		try {
			const until = new Date("2026-12-21T12:00:00Z");
			await extendVisitLinks("org1", "v1", until);
			expect(h.link.updateMany).toHaveBeenCalledWith({
				where: {
					purpose: "visit",
					entity_id: "v1",
					revoked_at: null,
					OR: [{ expires_at: null }, { expires_at: { gt: now } }],
				},
				data: { expires_at: until },
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("public base URLs", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("unsubscribeHeaders uses BACKEND_PUBLIC_URL without a trailing slash", () => {
		vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.example/");
		expect(unsubscribeHeaders("t 1")[0].Value).toBe(
			"<https://api.example/public/unsubscribe/one-click?t=t%201>",
		);
	});

	it("outside production a missing BACKEND_PUBLIC_URL falls back to localhost", () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("BACKEND_PUBLIC_URL", "");
		expect(unsubscribeHeaders("t")[0].Value).toMatch(
			/^<http:\/\/localhost:3000\//,
		);
	});

	it("in production a missing BACKEND_PUBLIC_URL throws instead of using localhost", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("BACKEND_PUBLIC_URL", "  ");
		expect(() => unsubscribeHeaders("t")).toThrow(
			"BACKEND_PUBLIC_URL is not set",
		);
	});

	it("in production issueLink throws when FRONTEND_URL is missing", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("FRONTEND_URL", "");
		await expect(issueLink("org-1", P)).rejects.toThrow(
			"FRONTEND_URL is not set",
		);
	});

	it("publicUrlWarning names each missing var, in production only", () => {
		expect(publicUrlWarning({ NODE_ENV: "development" })).toBeNull();
		expect(
			publicUrlWarning({
				NODE_ENV: "production",
				FRONTEND_URL: "https://app",
				BACKEND_PUBLIC_URL: "https://api",
			}),
		).toBeNull();
		expect(
			publicUrlWarning({
				NODE_ENV: "production",
				FRONTEND_URL: "https://app",
			}),
		).toMatch(/^BACKEND_PUBLIC_URL not set/);
		expect(publicUrlWarning({ NODE_ENV: "production" })).toMatch(
			/^FRONTEND_URL and BACKEND_PUBLIC_URL not set/,
		);
	});
});
