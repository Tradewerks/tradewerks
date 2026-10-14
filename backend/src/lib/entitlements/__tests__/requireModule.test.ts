import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const getEntitlements = vi.fn();
vi.mock("../../../services/entitlementService.js", () => ({ getEntitlements }));

const { requireModule } = await import("../requireModule.js");

const run = async (
	mw: ReturnType<typeof requireModule>,
	req: Partial<Request>,
) => {
	const res = {
		status: vi.fn().mockReturnThis(),
		json: vi.fn().mockReturnThis(),
	} as unknown as Response;
	const next = vi.fn();
	await mw(req as Request, res, next);
	return { res, next };
};
const user = (role = "dispatcher") => ({
	role,
	organization_id: "org1",
	permissions: [],
});
const withState = (state: string) =>
	getEntitlements.mockResolvedValue({ modules: { quotes: state } });

beforeEach(() => {
	getEntitlements.mockReset();
});

describe("requireModule", () => {
	it("passes read and write when on", async () => {
		withState("on");
		expect(
			(
				await run(requireModule("quotes"), {
					method: "POST",
					user: user(),
				} as never)
			).next,
		).toHaveBeenCalledWith();
	});

	it("off_by_org: read passes, write gets 403 MODULE_DISABLED", async () => {
		withState("off_by_org");
		expect(
			(
				await run(requireModule("quotes"), {
					method: "GET",
					user: user(),
				} as never)
			).next,
		).toHaveBeenCalledWith();
		const { res, next } = await run(requireModule("quotes"), {
			method: "PATCH",
			user: user(),
		} as never);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
		expect(
			(res.json as never as ReturnType<typeof vi.fn>).mock.calls[0][0]
				.error.code,
		).toBe("MODULE_DISABLED");
	});

	it("not_in_plan refuses reads too", async () => {
		withState("not_in_plan");
		const { res } = await run(requireModule("quotes"), {
			method: "GET",
			user: user(),
		} as never);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(
			(res.json as never as ReturnType<typeof vi.fn>).mock.calls[0][0]
				.error.code,
		).toBe("MODULE_NOT_IN_PLAN");
	});

	it("gates the admin role like everyone else", async () => {
		withState("not_in_plan");
		const { next } = await run(requireModule("quotes"), {
			method: "GET",
			user: user("admin"),
		} as never);
		expect(next).not.toHaveBeenCalled();
	});

	it("explicit access overrides the method default", async () => {
		withState("off_by_org");
		expect(
			(
				await run(requireModule("quotes", "read"), {
					method: "POST",
					user: user(),
				} as never)
			).next,
		).toHaveBeenCalledWith();
		expect(
			(
				await run(requireModule("quotes", "write"), {
					method: "GET",
					user: user(),
				} as never)
			).next,
		).not.toHaveBeenCalled();
	});

	it("answers 403 when the token has no organization", async () => {
		const { res } = await run(requireModule("quotes"), {
			method: "GET",
			user: { role: "dispatcher", organization_id: null },
		} as never);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(getEntitlements).not.toHaveBeenCalled();
	});

	it("treats a listed read-only path as a read whatever its method", async () => {
		withState("off_by_org");
		const mw = requireModule("quotes", undefined, {
			readOnlyPaths: [/^\/[^/]+\/preview$/],
		});
		expect(
			(
				await run(mw, {
					method: "POST",
					path: "/q1/preview",
					user: user(),
				} as never)
			).next,
		).toHaveBeenCalledWith();
		expect(
			(
				await run(mw, {
					method: "POST",
					path: "/q1/send",
					user: user(),
				} as never)
			).next,
		).not.toHaveBeenCalled();
	});

	it("throws when built with a module key the registry does not know", () => {
		expect(() => requireModule("quotez")).toThrow(/unknown module/);
	});

	it("forwards a lookup failure to the error handler", async () => {
		const err = Object.assign(new Error("down"), { statusCode: 503 });
		getEntitlements.mockRejectedValue(err);
		const { next } = await run(requireModule("quotes"), {
			method: "GET",
			user: user(),
		} as never);
		expect(next).toHaveBeenCalledWith(err);
	});
});
