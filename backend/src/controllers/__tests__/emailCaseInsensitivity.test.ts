import { describe, it, expect, vi, beforeEach } from "vitest";

// jwtService (pulled in transitively via oauthService) reads its secrets at
// import time — set them before anything loads, same as authReset.test.ts.
vi.hoisted(() => {
	process.env.JWT_ACCESS_SECRET = "test-access-secret";
	process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
	process.env.OTP_SECRET = "test-otp-secret";
});

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});

vi.mock("bcryptjs", () => ({
	default: {
		hash: vi.fn(async (pw: string) => `hashed(${pw})`),
		hashSync: vi.fn((pw: string) => `hashed(${pw})`),
		compare: vi.fn(async (pw: string, hash: string) => hash === `hashed(${pw})`),
	},
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(async () => undefined),
	buildChanges: vi.fn(() => ({})),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/emailService.js", () => ({
	sendEmailVerificationEmail: vi.fn(),
}));

import { db } from "../../db.js";
import { updateDispatcher } from "../dispatchersController.js";
import { updateTechnician } from "../techniciansController.js";
import { registerOrganization } from "../organizationsController.js";
import { authenticateUser } from "../../services/oauthService.js";
import { sendEmailVerificationEmail } from "../../services/emailService.js";
import type { FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;

// getScopedDb() (used for the "existing row" lookup) AND-wraps the caller's
// where clause with an organization_id filter — `{ where: { id } }` arrives
// here as `{ where: { AND: [{ id }, { organization_id }] } }`. The raw,
// unscoped dup-check queries (`db.technician`/`db.dispatcher`.findFirst) are
// not wrapped. These helpers read either shape.
type WhereArgs = { where?: { id?: string; email?: string; AND?: Array<{ id?: string; email?: string }> } };
const whereId = (args: WhereArgs) => args?.where?.id ?? args?.where?.AND?.[0]?.id;
const whereEmail = (args: WhereArgs) => args?.where?.email ?? args?.where?.AND?.[0]?.email;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("updateDispatcher — email is lowercased before comparison, dup-check, and persist", () => {
	it("treats a case-only edit as no change: skips the dup-check and persists lowercase", async () => {
		fake.dispatcher.findFirst.mockImplementation(async (args: WhereArgs) => {
			if (whereId(args) === "disp-1") {
				return { id: "disp-1", email: "jane@example.com", organization_id: "org-1" };
			}
			return null;
		});
		fake.dispatcher.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "disp-1",
			...data,
		}));

		const result = await updateDispatcher("disp-1", { email: "Jane@Example.com" }, "org-1");

		expect(result.err).toBe("");
		expect(fake.technician.findFirst).not.toHaveBeenCalled();
		// dispatcher.findFirst should only be the "existing" lookup by id — no dup-check by email
		expect(fake.dispatcher.findFirst.mock.calls.some((c: [WhereArgs]) => whereEmail(c[0]))).toBe(false);
		expect(fake.dispatcher.update.mock.calls[0][0].data.email).toBe("jane@example.com");
	});

	it("case-insensitively dup-checks a real email change and persists it lowercase", async () => {
		fake.dispatcher.findFirst.mockImplementation(async (args: WhereArgs) => {
			if (whereId(args) === "disp-1") {
				return { id: "disp-1", email: "jane@example.com", organization_id: "org-1" };
			}
			return null; // no dup found
		});
		fake.technician.findFirst.mockResolvedValue(null);
		fake.dispatcher.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "disp-1",
			...data,
		}));

		const result = await updateDispatcher("disp-1", { email: "New@Example.com" }, "org-1");

		expect(result.err).toBe("");
		expect(fake.technician.findFirst).toHaveBeenCalledWith({ where: { email: "new@example.com" } });
		expect(fake.dispatcher.update.mock.calls[0][0].data.email).toBe("new@example.com");
	});

	it("catches a duplicate that only matches once both sides are lowercased", async () => {
		fake.dispatcher.findFirst.mockImplementation(async (args: WhereArgs) => {
			if (whereId(args) === "disp-1") {
				return { id: "disp-1", email: "jane@example.com", organization_id: "org-1" };
			}
			if (whereEmail(args) === "other@example.com") {
				return { id: "disp-2", email: "other@example.com" };
			}
			return null;
		});
		fake.technician.findFirst.mockResolvedValue(null);

		const result = await updateDispatcher("disp-1", { email: "OTHER@Example.com" }, "org-1");

		expect(result).toEqual({ err: "Email already exists" });
		expect(fake.dispatcher.update).not.toHaveBeenCalled();
	});
});

describe("updateTechnician — email is lowercased before comparison, dup-check, and persist", () => {
	it("treats a case-only edit as no change: skips the dup-check and persists lowercase", async () => {
		fake.technician.findFirst.mockImplementation(async (args: WhereArgs) => {
			if (whereId(args) === "tech-1") {
				return { id: "tech-1", email: "sam@example.com", organization_id: "org-1" };
			}
			return null;
		});
		fake.technician.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "tech-1",
			...data,
		}));

		const result = await updateTechnician("tech-1", { email: "Sam@Example.com" }, "org-1");

		expect(result.err).toBe("");
		expect(fake.dispatcher.findFirst).not.toHaveBeenCalled();
		expect(fake.technician.findFirst.mock.calls.some((c: [WhereArgs]) => whereEmail(c[0]))).toBe(false);
		expect(fake.technician.update.mock.calls[0][0].data.email).toBe("sam@example.com");
	});

	it("catches a duplicate on the dispatcher table that only matches once both sides are lowercased", async () => {
		fake.technician.findFirst.mockImplementation(async (args: WhereArgs) => {
			if (whereId(args) === "tech-1") {
				return { id: "tech-1", email: "sam@example.com", organization_id: "org-1" };
			}
			return null; // no technician dup — falls through to dispatcher table
		});
		fake.dispatcher.findFirst.mockImplementation(async (args: WhereArgs) => {
			if (whereEmail(args) === "taken@example.com") {
				return { id: "disp-9", email: "taken@example.com" };
			}
			return null;
		});

		const result = await updateTechnician("tech-1", { email: "TAKEN@Example.com" }, "org-1");

		expect(result).toEqual({ err: "Email already exists" });
		expect(fake.technician.update).not.toHaveBeenCalled();
	});
});

describe("registerOrganization — admin_email is lowercased before the dup-check and the admin account is created", () => {
	it("lowercases admin_email before checking for an existing account and before creating the dispatcher row", async () => {
		fake.dispatcher.findUnique.mockResolvedValue(null);
		fake.plan_version.findFirst.mockResolvedValue({ id: "pv_x" });
		fake.org_entitlement.create.mockResolvedValue({});
		fake.organization.create.mockResolvedValue({ id: "org-1", name: "Acme" });
		fake.organization_role.createMany.mockResolvedValue({ count: 2 });
		fake.organization_role.create.mockResolvedValue({ id: "role-1" });
		fake.dispatcher.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "disp-new",
			...data,
		}));

		const result = await registerOrganization({
			org_name: "Acme",
			admin_name: "Jane",
			admin_email: "Jane@Example.COM",
			admin_password: "password123",
			business_type: "general",
		});

		expect(result.err).toBe("");
		expect(fake.dispatcher.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { email: "jane@example.com" } }),
		);
		expect(fake.dispatcher.create.mock.calls[0][0].data.email).toBe("jane@example.com");
		expect((result.item as { admin: { email: string } }).admin.email).toBe("jane@example.com");
		expect(vi.mocked(sendEmailVerificationEmail)).toHaveBeenCalledWith("jane@example.com", expect.any(String));
	});

	it("catches a signup that only collides once the existing admin_email is compared case-insensitively", async () => {
		fake.dispatcher.findUnique.mockResolvedValue({ id: "disp-existing", email: "jane@example.com" });

		const result = await registerOrganization({
			org_name: "Acme",
			admin_name: "Jane",
			admin_email: "JANE@EXAMPLE.COM",
			admin_password: "password123",
			business_type: "general",
		});

		expect(result).toEqual({ err: "An account with this email already exists" });
		expect(fake.organization.create).not.toHaveBeenCalled();
	});
});

describe("authenticateUser (OAuth password grant) — email is lowercased before the credential lookup", () => {
	it("finds a lowercase-stored dispatcher when the OAuth login form is typed with different case", async () => {
		fake.dispatcher.findUnique.mockImplementation(async (args: { where?: { email?: string } }) =>
			args?.where?.email === "jane@example.com"
				? {
						id: "disp-1",
						email: "jane@example.com",
						password: "hashed(pw)",
						organization_id: "org-1",
						role: "dispatcher",
					}
				: null,
		);
		fake.technician.findUnique.mockResolvedValue(null);

		const result = await authenticateUser("Jane@Example.com", "pw");

		expect(fake.dispatcher.findUnique).toHaveBeenCalledWith({
			where: { email: "jane@example.com" },
			omit: { password: false },
		});
		expect(result).toEqual({ userId: "disp-1", role: "dispatcher", organizationId: "org-1" });
	});
});
