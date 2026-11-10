import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});
vi.mock("bcryptjs", () => ({
	default: {
		hash: vi.fn(async (pw: string) => `hashed(${pw})`),
		compare: vi.fn(async (pw: string, hash: string) => hash === `hashed(${pw})`),
	},
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(async () => undefined),
	buildChanges: vi.fn(() => ({})),
}));
vi.mock("../../services/emailService.js", () => ({ sendEmailVerificationEmail: vi.fn() }));
vi.mock("../../services/jwtService.js", () => ({ generateRefreshToken: vi.fn(async () => "new-rt") }));
vi.mock("../../services/mfaService.js", () => ({
	getMfaEnabledUserIds: vi.fn(async () => new Set<string>()),
	isMfaEnabled: vi.fn(async () => false),
}));

import { db } from "../../db.js";
import { logActivity } from "../../services/logger.js";
import { changeDispatcherPassword, insertDispatcher } from "../dispatchersController.js";
import { changeTechnicianPassword } from "../techniciansController.js";
import { sendEmailVerificationEmail } from "../../services/emailService.js";
import type { FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;
const logged = () => vi.mocked(logActivity).mock.calls.map((c) => c[0]);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("change-password flows never write hashes into log.changes (review B3 / L1)", () => {
	it("dispatcher: opts into the hash for the check, logs [hashed] placeholders", async () => {
		fake.dispatcher.findFirst.mockResolvedValue({ id: "disp-1", organization_id: "org-1", password: "hashed(old-pass)" });
		fake.dispatcher.update.mockResolvedValue({});

		const result = await changeDispatcherPassword(
			"disp-1",
			"org-1",
			{ current_password: "old-pass", new_password: "new-pass-123" },
			{ dispatcherId: "disp-1" },
		);

		expect(result.err).toBe("");
		expect(result.data).toEqual({ refreshToken: "new-rt" });
		expect(fake.jwt_refresh_token.deleteMany).toHaveBeenCalledWith({ where: { userId: "disp-1" } });
		expect(fake.dispatcher.findFirst.mock.calls[0][0].omit).toEqual({ password: false });
		expect(fake.dispatcher.update.mock.calls[0][0].data).toEqual({ password: "hashed(new-pass-123)" });

		const entry = logged()[0];
		expect(entry).toMatchObject({
			event_type: "dispatcher.password.changed",
			entity_type: "dispatcher",
			entity_id: "disp-1",
			changes: { password: { old: "[hashed]", new: "[hashed]" } },
		});
		expect(JSON.stringify(entry)).not.toContain("hashed(");
	});

	it("dispatcher: rejects a wrong current password without logging", async () => {
		fake.dispatcher.findFirst.mockResolvedValue({ id: "disp-1", organization_id: "org-1", password: "hashed(old-pass)" });
		const result = await changeDispatcherPassword("disp-1", "org-1", { current_password: "nope", new_password: "new-pass-123" });
		expect(result).toEqual({ err: "Current password is incorrect" });
		expect(logActivity).not.toHaveBeenCalled();
		expect(fake.jwt_refresh_token.deleteMany).not.toHaveBeenCalled();
	});

	it("technician: logs under technician.password.changed / technician with [hashed] placeholders", async () => {
		fake.technician.findFirst.mockResolvedValue({ id: "tech-1", organization_id: "org-1", password: "hashed(old-pass)" });
		fake.technician.update.mockResolvedValue({});

		const result = await changeTechnicianPassword(
			"tech-1",
			"org-1",
			{ current_password: "old-pass", new_password: "new-pass-123" },
			{ techId: "tech-1" },
		);

		expect(result.err).toBe("");
		expect(result.data).toEqual({ refreshToken: "new-rt" });
		expect(fake.jwt_refresh_token.deleteMany).toHaveBeenCalledWith({ where: { userId: "tech-1" } });
		expect(fake.technician.findFirst.mock.calls[0][0].omit).toEqual({ password: false });
		const entry = logged()[0];
		expect(entry).toMatchObject({
			event_type: "technician.password.changed",
			entity_type: "technician",
			entity_id: "tech-1",
			actor_type: "technician",
			changes: { password: { old: "[hashed]", new: "[hashed]" } },
		});
		expect(JSON.stringify(entry)).not.toContain("hashed(");
	});
});

describe("insertDispatcher — verification token stays server-side (review B2)", () => {
	it("emails the locally generated token and does not rely on the omitted column", async () => {
		fake.technician.findFirst.mockResolvedValue(null);
		fake.dispatcher.findFirst.mockResolvedValue(null);
		// Simulate Prisma's omitted create() result: no credential columns come back.
		fake.dispatcher.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "disp-new",
			name: data.name,
			email: data.email,
			phone: data.phone ?? null,
			title: data.title,
			organization_id: data.organization_id,
		}));

		const result = await insertDispatcher(
			{ name: "New", email: "new@example.com", title: "Dispatcher", description: "", password: "strongpass1" },
			"org-1",
			{ dispatcherId: "admin-1" },
		);

		expect(result.err).toBe("");
		const createData = fake.dispatcher.create.mock.calls[0][0].data;
		expect(createData.email_verification_token).toEqual(expect.any(String));
		expect(vi.mocked(sendEmailVerificationEmail)).toHaveBeenCalledWith(
			"new@example.com",
			createData.email_verification_token,
			undefined,
		);
		expect(result.item).not.toHaveProperty("password");
		expect(result.item).not.toHaveProperty("email_verification_token");
	});
});
