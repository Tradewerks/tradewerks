import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction, Router } from "express";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", () => ({
	db: {
		organization: { findUnique: vi.fn(), update: vi.fn() },
		plan: { findUnique: vi.fn(async () => ({ label: "Pro" })) },
		org_entitlement: { findUnique: vi.fn(async () => null), updateMany: vi.fn() },
		$executeRaw: vi.fn(),
	},
}));

vi.mock("../../services/wasabiService.js", () => ({
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
	signImageUrl: vi.fn(async (url: string | null) => url),
}));

vi.mock("../../lib/upload.js", () => ({
	imageUpload: {
		single: () => (_req: Request, _res: Response, next: NextFunction) => next(),
	},
}));

vi.mock("../../services/entitlementService.js", () => ({
	getEntitlements: vi.fn(async () => ({
		planKey: "pro",
		planVersion: 1,
		trialActive: false,
		modules: {},
		limits: { ai_calls_month: 500 },
	})),
	previewDisable: vi.fn(),
	setModuleChoices: vi.fn(),
	isModuleOn: vi.fn(async () => true),
	tierLabel: vi.fn(async () => "Pro"),
}));
const summary = vi.hoisted(() => ({ period_start: "2026-10-01", meters: {} }));
vi.mock("../../lib/entitlements/quota.js", () => ({ getUsageSummary: vi.fn(async () => summary) }));

vi.mock("../../services/logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../services/logger.js")>();
	return { ...actual, logActivity: vi.fn() };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import orgRouter from "../org.js";
import orgEntitlementsRouter from "../orgEntitlements.js";
import { callRoute } from "./harness.js";
import { getUsageSummary } from "../../lib/entitlements/quota.js";
import { db } from "../../db.js";
import { logActivity } from "../../services/logger.js";
import { Prisma } from "../../../generated/prisma/client.js";

const mockDb = vi.mocked(db, true);

// ── Test harness — route handlers are inline in org.ts, so pull them straight
// off the Router's internal stack rather than duplicating them here. ─────────

function getHandlers(method: "get" | "patch", path: string): Array<
	(req: Request, res: Response, next: NextFunction) => unknown
> {
	const stack = (orgRouter as unknown as Router & {
		stack: Array<{
			route?: {
				path: string;
				methods: Record<string, boolean>;
				stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => unknown }>;
			};
		}>;
	}).stack;
	const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
	if (!layer?.route) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
	return layer.route.stack.map((s) => s.handle);
}

function makeReq(overrides: Partial<Request> = {}): Request {
	return {
		user: { organization_id: "org-1", role: "admin", permissions: [] },
		headers: {},
		body: {},
		...overrides,
	} as unknown as Request;
}

function makeRes() {
	const res: Partial<Response> & { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } = {
		status: vi.fn(),
		json: vi.fn(),
	};
	res.status = vi.fn().mockReturnValue(res as Response);
	res.json = vi.fn().mockReturnValue(res as Response);
	return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

// Dispatches handlers[i..] like Express would, but resolves once the chain is
// actually done — either a handler ends the response without calling next(),
// or next() is called all the way past the last handler.
function dispatch(
	handlers: Array<(req: Request, res: Response, next: NextFunction) => unknown>,
	req: Request,
	res: Response,
	i: number,
): Promise<void> {
	if (i >= handlers.length) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		let nextCalled = false;
		const next: NextFunction = ((err?: unknown) => {
			nextCalled = true;
			if (err) return reject(err);
			dispatch(handlers, req, res, i + 1).then(resolve, reject);
		}) as NextFunction;
		Promise.resolve(handlers[i](req, res, next))
			.then(() => {
				if (!nextCalled) resolve();
			})
			.catch(reject);
	});
}

async function runChain(
	handlers: Array<(req: Request, res: Response, next: NextFunction) => unknown>,
	req: Request,
	res: Response,
) {
	await dispatch(handlers, req, res, 0);
}

const baseOrg = {
	id: "org-1",
	name: "Acme HVAC",
	logo_url: null,
	phone: null,
	address: null,
	coords: null,
	email: null,
	website: null,
	tax_rate: "0",
	restock_mode: "tech_self_serve",
	measurement_system: "imperial",
	mfa_required: false,
};

describe("org routes — measurement_system", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.organization.findUnique.mockResolvedValue(baseOrg as never);
	});

	it("GET / returns measurement_system on the response", async () => {
		mockDb.organization.findUnique.mockResolvedValue(baseOrg as never);
		const handlers = getHandlers("get", "/");
		const req = makeReq();
		const res = makeRes();
		await runChain(handlers, req, res);

		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({ measurement_system: "imperial" }),
			}),
		);
	});

	it("PATCH / accepts a valid metric value and returns it", async () => {
		mockDb.organization.update.mockResolvedValue({
			...baseOrg,
			measurement_system: "metric",
		} as never);
		const handlers = getHandlers("patch", "/");
		const req = makeReq({ body: { measurement_system: "metric" } });
		const res = makeRes();
		await runChain(handlers, req, res);

		expect(mockDb.organization.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "org-1" },
				data: expect.objectContaining({ measurement_system: "metric" }),
			}),
		);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({ measurement_system: "metric" }),
			}),
		);
	});

	it("PATCH / rejects an invalid measurement_system value", async () => {
		const handlers = getHandlers("patch", "/");
		const req = makeReq({ body: { measurement_system: "freedom" } });
		const res = makeRes();
		await runChain(handlers, req, res);

		expect(mockDb.organization.update).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				success: false,
				error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
			}),
		);
	});
});

describe("org routes — field purchase second sign-off threshold", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.organization.findUnique.mockResolvedValue(baseOrg as never);
	});

	it("PATCH / stores a threshold and returns it as a Decimal string", async () => {
		mockDb.organization.update.mockResolvedValue({
			...baseOrg,
			field_purchase_second_signoff_threshold: "500",
		} as never);
		const handlers = getHandlers("patch", "/");
		const req = makeReq({ body: { field_purchase_second_signoff_threshold: 500 } });
		const res = makeRes();
		await runChain(handlers, req, res);

		expect(mockDb.organization.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					field_purchase_second_signoff_threshold: 500,
				}),
			}),
		);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					field_purchase_second_signoff_threshold: "500",
				}),
			}),
		);
	});

	// null is the off switch, so it has to survive the schema rather than be
	// dropped the way an absent optional is.
	it("PATCH / clears the threshold with an explicit null", async () => {
		mockDb.organization.update.mockResolvedValue({
			...baseOrg,
			field_purchase_second_signoff_threshold: null,
		} as never);
		const handlers = getHandlers("patch", "/");
		const req = makeReq({
			body: { field_purchase_second_signoff_threshold: null },
		});
		const res = makeRes();
		await runChain(handlers, req, res);

		expect(mockDb.organization.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					field_purchase_second_signoff_threshold: null,
				}),
			}),
		);
	});

	it("PATCH / rejects a negative threshold", async () => {
		const handlers = getHandlers("patch", "/");
		const req = makeReq({
			body: { field_purchase_second_signoff_threshold: -1 },
		});
		const res = makeRes();
		await runChain(handlers, req, res);

		expect(mockDb.organization.update).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("PATCH / leaves the threshold untouched when the field is absent", async () => {
		mockDb.organization.update.mockResolvedValue(baseOrg as never);
		const handlers = getHandlers("patch", "/");
		const req = makeReq({ body: { name: "Acme HVAC" } });
		const res = makeRes();
		await runChain(handlers, req, res);

		const data = mockDb.organization.update.mock.calls[0][0].data as Record<
			string,
			unknown
		>;
		expect(data).not.toHaveProperty("field_purchase_second_signoff_threshold");
	});
});

describe("org routes — settings audit log", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.organization.findUnique.mockResolvedValue(baseOrg as never);
	});

	it("logs one organization.settings_updated row with only the changed fields", async () => {
		mockDb.organization.update.mockResolvedValue({
			...baseOrg,
			restock_mode: "dispatch_prepared",
		} as never);
		const req = makeReq({
			user: { uid: "disp-1", organization_id: "org-1", role: "admin", permissions: [] },
			body: { name: "Acme HVAC", restock_mode: "dispatch_prepared", measurement_system: "imperial" },
		} as Partial<Request>);
		await runChain(getHandlers("patch", "/"), req, makeRes());

		expect(logActivity).toHaveBeenCalledTimes(1);
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "organization.settings_updated",
				action: "updated",
				entity_type: "organization",
				entity_id: "org-1",
				organization_id: "org-1",
				actor_type: "dispatcher",
				actor_id: "disp-1",
				changes: { restock_mode: { old: "tech_self_serve", new: "dispatch_prepared" } },
			}),
		);
	});

	it("writes no log when the save changes nothing", async () => {
		mockDb.organization.update.mockResolvedValue(baseOrg as never);
		const req = makeReq({
			body: { name: "Acme HVAC", restock_mode: "tech_self_serve", measurement_system: "imperial" },
		});
		await runChain(getHandlers("patch", "/"), req, makeRes());

		expect(logActivity).not.toHaveBeenCalled();
	});

	// The stored Decimal and the body's number must compare equal, or every
	// no-change save would log a phantom threshold change.
	it("writes no log when the threshold is resent unchanged", async () => {
		const stored = {
			...baseOrg,
			field_purchase_second_signoff_threshold: new Prisma.Decimal("500"),
		};
		mockDb.organization.findUnique.mockResolvedValue(stored as never);
		mockDb.organization.update.mockResolvedValue(stored as never);
		const req = makeReq({
			body: {
				name: "Acme HVAC",
				restock_mode: "tech_self_serve",
				measurement_system: "imperial",
				field_purchase_second_signoff_threshold: 500,
			},
		});
		await runChain(getHandlers("patch", "/"), req, makeRes());

		expect(logActivity).not.toHaveBeenCalled();
	});

	it("answers 404 without updating when the org row is gone", async () => {
		mockDb.organization.findUnique.mockResolvedValue(null as never);
		const res = makeRes();
		await runChain(getHandlers("patch", "/"), makeReq({ body: { name: "X" } }), res);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(mockDb.organization.update).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});
});

describe("GET /org/entitlements usage (build plan 2)", () => {
	it("includes usage for admins", async () => {
		const r = await callRoute(orgEntitlementsRouter, "get", "/", {
			user: { uid: "a", role: "admin", organization_id: "org-1", permissions: null },
		});
		expect(r.body.data.usage).toEqual(summary);
	});

	it("is null for a user without manage_organization", async () => {
		const r = await callRoute(orgEntitlementsRouter, "get", "/", {
			user: { uid: "d", role: "dispatcher", organization_id: "org-1", permissions: ["view_jobs"] },
		});
		expect(r.body.data.usage).toBeNull();
	});

	it("still answers with module states when the usage summary fails", async () => {
		vi.mocked(getUsageSummary).mockRejectedValueOnce(new Error("db down"));
		const r = await callRoute(orgEntitlementsRouter, "get", "/", {
			user: { uid: "a", role: "admin", organization_id: "org-1", permissions: null },
		});
		expect(r.status).toBe(200);
		expect(r.body.data.usage).toBeNull();
		expect(r.body.data.limits).toEqual({ ai_calls_month: 500 });
	});

	it("GET / includes the tier label", async () => {
		const r = await callRoute(orgEntitlementsRouter, "get", "/", {
			user: { uid: "a", role: "admin", organization_id: "org-1", permissions: null },
		});
		expect(r.body.data.plan).toMatchObject({ key: "pro", label: "Pro" });
	});
});

describe("org setup state (build plan 4)", () => {
	const admin = { uid: "d-1", organization_id: "org-1", role: "admin", permissions: [] };
	const plain = { uid: "d-2", organization_id: "org-1", role: "dispatcher", permissions: [] };
	const get = (user: Record<string, unknown>) =>
		callRoute(orgEntitlementsRouter, "get", "/", { user });
	const post = (path: string, user: Record<string, unknown>) =>
		callRoute(orgEntitlementsRouter, "post", path, { user });

	it("GET includes template, review state and the active trial", async () => {
		mockDb.org_entitlement.findUnique.mockResolvedValueOnce({
			template_key: "plumbing",
			modules_reviewed_at: null,
			trial_ends_at: new Date(Date.now() + 86_400_000),
			trial_plan_version: { plan: { label: "Enterprise" } },
		} as never);
		const r = await get(admin);
		expect(r.body.data.setup).toEqual({
			templateKey: "plumbing",
			modulesReviewed: false,
			trial: { tierLabel: "Enterprise", endsAt: expect.any(String) },
		});
	});

	it("a setup read failure yields setup: null, not a failed payload", async () => {
		mockDb.org_entitlement.findUnique.mockRejectedValueOnce(new Error("db down"));
		const r = await get(admin);
		expect(r.status).toBe(200);
		expect(r.body.data.setup).toBeNull();
	});

	it("POST /modules-reviewed marks once with raw SQL", async () => {
		mockDb.$executeRaw.mockResolvedValueOnce(1 as never);
		const r = await post("/modules-reviewed", admin);
		expect(r.status).toBe(200);
		expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("POST /modules-reviewed is refused without manage_organization", async () => {
		const r = await post("/modules-reviewed", plain);
		expect(r.status).toBe(403);
	});
});

describe("org routes — restock_mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.organization.findUnique.mockResolvedValue(baseOrg as never);
	});

	it("GET / returns restock_mode", async () => {
		const res = makeRes();
		await runChain(getHandlers("get", "/"), makeReq(), res);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ restock_mode: "tech_self_serve" }),
			}),
		);
	});

	it("PATCH / accepts dispatch_prepared", async () => {
		mockDb.organization.update.mockResolvedValue({
			...baseOrg,
			restock_mode: "dispatch_prepared",
		} as never);
		const res = makeRes();
		await runChain(
			getHandlers("patch", "/"),
			makeReq({ body: { restock_mode: "dispatch_prepared" } }),
			res,
		);
		expect(mockDb.organization.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ restock_mode: "dispatch_prepared" }),
			}),
		);
	});

	it("PATCH / rejects an unknown restock_mode", async () => {
		const res = makeRes();
		await runChain(
			getHandlers("patch", "/"),
			makeReq({ body: { restock_mode: "warehouse_only" } }),
			res,
		);
		expect(mockDb.organization.update).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("PATCH / requires manage_organization", () => {
		const guard = getHandlers("patch", "/")[0];
		const res = makeRes();
		const next = vi.fn();
		guard(
			makeReq({ user: { organization_id: "org-1", role: "dispatcher", permissions: [] } } as never),
			res,
			next as never,
		);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();
	});
});
