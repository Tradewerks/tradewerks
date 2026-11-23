import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../../db.js", () => ({ db: {} }));

import {
	requirePermission,
	requireAnyPermission,
	requirePermissionOrSelf,
	requireAnyPermissionOrSelf,
	denyTechnicians,
} from "../requirePermissions.js";

type User = { uid: string; role: string; permissions: string[] | null };

function makeReq(user: User | undefined, params: Record<string, string> = {}): Request {
	return { user, params } as unknown as Request;
}

function makeRes() {
	const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
	return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

const admin: User = { uid: "admin-1", role: "admin", permissions: [] };
const dispWith = (...perms: string[]): User => ({ uid: "disp-1", role: "dispatcher", permissions: perms });
const techWith = (...perms: string[]): User => ({ uid: "tech-1", role: "technician", permissions: perms });

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

async function run(mw: Middleware, req: Request) {
	const res = makeRes();
	const next = vi.fn();
	await mw(req, res, next);
	return { res, next, passed: next.mock.calls.length === 1, status: res.status.mock.calls[0]?.[0] as number | undefined };
}

describe("requirePermissions middlewares — table-driven", () => {
	beforeEach(() => vi.clearAllMocks());

	describe("requirePermission", () => {
		const mw = requirePermission("view_jobs");
		it.each<[string, User | undefined, boolean]>([
			["admin bypasses", admin, true],
			["dispatcher with the permission passes", dispWith("view_jobs"), true],
			["dispatcher with other permissions is denied", dispWith("view_clients"), false],
			["dispatcher with no permissions is denied", dispWith(), false],
			["technician with the permission passes", techWith("view_jobs"), true],
			["permissions: null is treated as none", { uid: "x", role: "dispatcher", permissions: null }, false],
			["no user is denied", undefined, false],
		])("%s", async (_label, user, expected) => {
			const r = await run(mw, makeReq(user));
			expect(r.passed).toBe(expected);
			if (!expected) {
				expect(r.status).toBe(403);
				expect(r.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
			}
		});
	});

	describe("requireAnyPermission", () => {
		const mw = requireAnyPermission("view_clients", "view_jobs");
		it.each<[string, User | undefined, boolean]>([
			["admin bypasses", admin, true],
			["holder of the first permission passes", dispWith("view_clients"), true],
			["holder of the second permission passes", dispWith("view_jobs"), true],
			["holder of neither is denied", dispWith("view_quotes"), false],
			["no user is denied", undefined, false],
		])("%s", async (_label, user, expected) => {
			const r = await run(mw, makeReq(user));
			expect(r.passed).toBe(expected);
			if (!expected) expect(r.status).toBe(403);
		});
	});

	describe("requirePermissionOrSelf", () => {
		const mw = requirePermissionOrSelf("view_dispatchers");
		it.each<[string, User | undefined, Record<string, string>, boolean]>([
			["self passes without the permission", dispWith(), { id: "disp-1" }, true],
			["other user with the permission passes", dispWith("view_dispatchers"), { id: "disp-2" }, true],
			["other user without the permission is denied", dispWith(), { id: "disp-2" }, false],
			["technician on another id without permission is denied", techWith(), { id: "disp-2" }, false],
			["admin on another id passes", admin, { id: "disp-2" }, true],
			["no user is denied", undefined, { id: "disp-2" }, false],
		])("%s", async (_label, user, params, expected) => {
			const r = await run(mw, makeReq(user, params));
			expect(r.passed).toBe(expected);
			if (!expected) expect(r.status).toBe(403);
		});

		it("honours a custom id param name", async () => {
			const custom = requirePermissionOrSelf("view_technicians", "techId");
			const ok = await run(custom, makeReq(techWith(), { techId: "tech-1" }));
			expect(ok.passed).toBe(true);
			const denied = await run(custom, makeReq(techWith(), { techId: "tech-9", id: "tech-1" }));
			expect(denied.passed).toBe(false);
			expect(denied.status).toBe(403);
		});
	});

	describe("requireAnyPermissionOrSelf", () => {
		const mw = requireAnyPermissionOrSelf(["manage_vehicles"], "id");
		it.each<[string, User | undefined, Record<string, string>, boolean]>([
			["self passes", techWith(), { id: "tech-1" }, true],
			["permission holder passes on others", dispWith("manage_vehicles"), { id: "tech-1" }, true],
			["non-holder on others is denied", techWith("use_vehicles"), { id: "tech-2" }, false],
		])("%s", async (_label, user, params, expected) => {
			const r = await run(mw, makeReq(user, params));
			expect(r.passed).toBe(expected);
			if (!expected) expect(r.status).toBe(403);
		});
	});

	describe("denyTechnicians", () => {
		it.each<[string, User | undefined, boolean]>([
			["technician is denied regardless of permissions", techWith("view_projects"), false],
			["dispatcher passes", dispWith(), true],
			["admin passes", admin, true],
			["anonymous passes through to later guards", undefined, true],
		])("%s", async (_label, user, expected) => {
			const r = await run(denyTechnicians, makeReq(user));
			expect(r.passed).toBe(expected);
			if (!expected) {
				expect(r.status).toBe(403);
				expect(r.res.json).toHaveBeenCalledWith(
					expect.objectContaining({ error: expect.objectContaining({ code: "FORBIDDEN" }) }),
				);
			}
		});
	});
});
