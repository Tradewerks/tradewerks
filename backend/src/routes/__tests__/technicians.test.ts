import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
	process.env.JWT_ACCESS_SECRET ??= "test-access-secret";
	process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret";
	process.env.OTP_SECRET ??= "test-otp-secret";
});

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("./harness.js");
	return { db: createFakeDb() };
});
vi.mock("../../services/emailService.js", () => ({
	sendEmail: vi.fn(),
	sendOTPEmail: vi.fn(),
	sendPasswordResetEmail: vi.fn(),
	sendEmailVerificationEmail: vi.fn(),
}));
vi.mock("../../services/otpServce.js", () => ({ createOTP: vi.fn(), OTP_DISABLED: true, verifyOTP: vi.fn() }));
vi.mock("../../controllers/mfaController.js", () => ({ resetMfa: vi.fn() }));
vi.mock("../../services/mfaService.js", () => ({
	getMfaEnabledUserIds: vi.fn(async () => new Set<string>()),
	isMfaEnabled: vi.fn(async () => false),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(async () => undefined),
	buildChanges: vi.fn(() => ({})),
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn(() => ({
		emit: vi.fn(),
		to: vi.fn().mockReturnThis(),
		in: vi.fn(() => ({ disconnectSockets: vi.fn() })),
	})),
	emitToOrg: vi.fn(),
	emitInventoryUpdated: vi.fn(),
}));
const { entitlementLimits } = vi.hoisted(() => ({
	entitlementLimits: {} as Record<string, number | null>,
}));
vi.mock("../../services/entitlementService.js", () => ({
	getEntitlements: vi.fn(async () => ({ limits: entitlementLimits })),
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../controllers/jobVisitsController.js", () => ({ getJobVisitsByTechId: vi.fn(async () => []) }));
vi.mock("../../controllers/vehiclesController.js", () => ({ setTechnicianVehicle: vi.fn() }));
vi.mock("../../services/wasabiService.js", () => ({
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
	signImageUrl: vi.fn(async (u: string | null) => u),
	signImageUrls: vi.fn(async (u: string[]) => u),
	isOwnBucketUrl: () => true,
}));

import techniciansRouter from "../technicians.js";
import { db } from "../../db.js";
import { callRoute, leaves, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;

const SECRET_KEYS = ["password", "password_reset_token", "password_reset_token_expires_at"];
const WITHHELD_KEYS = [...SECRET_KEYS, "hourly_rate", "cost_rate"];

const technicianRow = {
	id: "tech-1",
	organization_id: "org-1",
	name: "Tess",
	email: "tess@example.com",
	phone: "555",
	title: "Tech",
	description: "",
	status: "Available",
	organization_role_id: "role-1",
	organization_role: { id: "role-1", name: "Field", permissions: ["view_visits"] },
	visit_techs: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	fake.technician.findFirst.mockResolvedValue(technicianRow);
	fake.technician.findMany.mockResolvedValue([technicianRow]);
	fake.log.findMany.mockResolvedValue([]);
	fake.log.count.mockResolvedValue(0);
});

describe("GET /technicians — no credential columns in the payload (review B2 / S2)", () => {
	it("list and detail pass the omitted rows through and never opt back into secrets", async () => {
		const list = await callRoute(techniciansRouter, "get", "/", {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_technicians"] },
		});
		expect(list.status).toBe(200);
		for (const key of SECRET_KEYS) expect(list.body.data[0]).not.toHaveProperty(key);
		// Explicit allowlist, not the global omit — any `select` bypasses that omit.
		// Must name no credential column and no pay column.
		const listArgs = fake.technician.findMany.mock.calls[0][0];
		expect(listArgs.select).toBeDefined();
		for (const key of WITHHELD_KEYS) expect(listArgs.select).not.toHaveProperty(key);
		expect(JSON.stringify(listArgs.select)).not.toMatch(/password|hourly_rate|cost_rate/);

		const one = await callRoute(techniciansRouter, "get", "/:id", {
			user: { uid: "tech-1", role: "technician", permissions: [] },
			params: { id: "tech-1" },
		});
		expect(one.status).toBe(200);
		for (const key of SECRET_KEYS) expect(one.body.data).not.toHaveProperty(key);
		expect(one.body.data).toMatchObject({ id: "tech-1", permissions: ["view_visits"], mfaEnabled: false });
	});

	it("technicians cannot list the whole roster", async () => {
		const r = await callRoute(techniciansRouter, "get", "/", {
			user: { uid: "tech-1", role: "technician", permissions: ["view_visits"] },
		});
		expect(r.status).toBe(403);
		expect(fake.technician.findMany).not.toHaveBeenCalled();
	});
});

describe("GET /technicians/:id/changes — limit validation + denylist (review P2-11, L1)", () => {
	it.each(["-1", "0", "2.5", "x", "201"])("returns 400 for limit=%s", async (limit) => {
		const r = await callRoute(techniciansRouter, "get", "/:id/changes", {
			user: { uid: "tech-1", role: "technician", permissions: [] },
			params: { id: "tech-1" },
			query: { limit },
		});
		expect(r.status).toBe(400);
		expect(r.body.error.code).toBe("VALIDATION_ERROR");
		expect(fake.log.findMany).not.toHaveBeenCalled();
	});

	it("queries technician actor rows with the sensitive-event denylist and strips secret keys", async () => {
		fake.log.findMany.mockResolvedValue([
			{ id: "l1", event_type: "technician.updated", action: "updated", entity_type: "technician", entity_id: "tech-1", actor_type: "technician", actor_id: "tech-1", changes: { status: { old: "Offline", new: "Available" }, password: { old: "$2a$10$a", new: "$2a$10$b" } }, timestamp: new Date() },
		]);
		fake.log.count.mockResolvedValue(1);
		const r = await callRoute(techniciansRouter, "get", "/:id/changes", {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_technicians"] },
			params: { id: "tech-1" },
			query: { limit: "5" },
		});
		expect(r.status).toBe(200);
		expect(r.body.data[0].changes).toEqual({ status: { old: "Offline", new: "Available" } });
		const where = JSON.stringify(fake.log.findMany.mock.calls[0][0].where);
		// Widened to include "agent" so a technician's change history also shows
		// what an assistant did on their behalf; actor_id still pins it to them.
		expect(where).toContain('"actor_type":{"in":["technician","agent"]}');
		expect(where).toContain('"actor_id":"tech-1"');
		expect(where).toContain('"contains":".password."');
		expect(fake.log.findMany.mock.calls[0][0].take).toBe(6);
	});

	it("denies another technician's history without view_technicians", async () => {
		const r = await callRoute(techniciansRouter, "get", "/:id/changes", {
			user: { uid: "tech-2", role: "technician", permissions: [] },
			params: { id: "tech-1" },
		});
		expect(r.status).toBe(403);
	});
});

describe("technician seats and deactivation (build plan 2)", () => {
	const admin = { uid: "disp-1", role: "admin", organization_id: "org-1", permissions: null };
	const body = {
		name: "New Tech",
		email: "new@example.com",
		phone: "555",
		title: "Tech",
		description: "",
		coords: { lat: 0, lon: 0 },
		hire_date: new Date().toISOString(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		for (const k of Object.keys(entitlementLimits)) delete entitlementLimits[k];
		fake.technician.findFirst.mockResolvedValue(null);
		fake.dispatcher.findFirst.mockResolvedValue(null);
	});

	it("POST / refuses with 409 SEAT_LIMIT_REACHED at the cap, under the seat lock", async () => {
		entitlementLimits.technicians = 5;
		fake.technician.count.mockResolvedValue(5);
		await expect(callRoute(techniciansRouter, "post", "/", { user: admin, body })).rejects.toMatchObject({
			statusCode: 409,
			code: "SEAT_LIMIT_REACHED",
			message: "Your subscription includes 5 technicians. Deactivate one or upgrade to add more.",
		});
		const lockSql = fake.$executeRaw.mock.calls.map((c: unknown[]) => (c[0] as string[]).join("?"));
		expect(lockSql.some((s: string) => s.includes("pg_advisory_xact_lock(7"))).toBe(true);
		expect(fake.technician.create).not.toHaveBeenCalled();
	});

	it("over the cap after a downgrade still refuses", async () => {
		entitlementLimits.technicians = 3;
		fake.technician.count.mockResolvedValue(8);
		await expect(callRoute(techniciansRouter, "post", "/", { user: admin, body })).rejects.toMatchObject({
			statusCode: 409,
		});
	});

	it("unlimited skips the count", async () => {
		entitlementLimits.technicians = null;
		fake.technician.create.mockResolvedValue({ id: "t-new", ...body, status: "Offline" });
		const r = await callRoute(techniciansRouter, "post", "/", { user: admin, body });
		expect(r.status).toBe(201);
		expect(fake.technician.count).not.toHaveBeenCalled();
	});

	it("counts only active technicians", async () => {
		entitlementLimits.technicians = 5;
		fake.technician.count.mockResolvedValue(4);
		fake.technician.create.mockResolvedValue({ id: "t-new", ...body, status: "Offline" });
		await callRoute(techniciansRouter, "post", "/", { user: admin, body });
		expect(leaves(fake.technician.count.mock.calls[0][0].where)).toEqual(
			expect.arrayContaining([{ organization_id: "org-1" }, { deactivated_at: null }]),
		);
	});

	it("deactivate refuses while the technician has an open visit", async () => {
		fake.technician.findFirst.mockResolvedValue({ id: "tech-1", name: "Tess", deactivated_at: null });
		fake.job_visit_technician.count.mockResolvedValue(2);
		const r = await callRoute(techniciansRouter, "post", "/:id/deactivate", {
			user: admin,
			params: { id: "tech-1" },
		});
		expect(r.status).toBe(400);
		expect(r.body.error.message).toBe("Tess has 2 open visits. Complete or reassign them first.");
		expect(fake.technician.update).not.toHaveBeenCalled();
	});

	it("deactivate sets deactivated_at, goes Offline, leaves the vehicle, revokes refresh tokens", async () => {
		fake.technician.findFirst.mockResolvedValue({ id: "tech-1", name: "Tess", deactivated_at: null });
		fake.job_visit_technician.count.mockResolvedValue(0);
		fake.technician.update.mockResolvedValue({ id: "tech-1", deactivated_at: new Date() });
		fake.jwt_refresh_token.deleteMany.mockResolvedValue({ count: 1 });
		const r = await callRoute(techniciansRouter, "post", "/:id/deactivate", {
			user: admin,
			params: { id: "tech-1" },
		});
		expect(r.status).toBe(200);
		expect(fake.technician.update.mock.calls[0][0].data).toMatchObject({
			deactivated_at: expect.any(Date),
			status: "Offline",
			current_vehicle_id: null,
		});
		expect(fake.jwt_refresh_token.deleteMany).toHaveBeenCalledWith({ where: { userId: "tech-1" } });
	});

	it("reactivate checks the seat cap", async () => {
		entitlementLimits.technicians = 5;
		fake.technician.findFirst.mockResolvedValue({ id: "tech-1", name: "Tess", deactivated_at: new Date() });
		fake.technician.count.mockResolvedValue(5);
		await expect(
			callRoute(techniciansRouter, "post", "/:id/reactivate", { user: admin, params: { id: "tech-1" } }),
		).rejects.toMatchObject({ statusCode: 409, code: "SEAT_LIMIT_REACHED" });
	});

	it("reactivate clears deactivated_at", async () => {
		entitlementLimits.technicians = 5;
		fake.technician.findFirst.mockResolvedValue({ id: "tech-1", name: "Tess", deactivated_at: new Date() });
		fake.technician.count.mockResolvedValue(4);
		fake.technician.update.mockResolvedValue({ id: "tech-1", deactivated_at: null });
		const r = await callRoute(techniciansRouter, "post", "/:id/reactivate", {
			user: admin,
			params: { id: "tech-1" },
		});
		expect(r.status).toBe(200);
		expect(fake.technician.update.mock.calls[0][0].data).toEqual({ deactivated_at: null });
	});
});
