import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", () => ({ db: {} }));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn(),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/emailService.js", () => ({
	sendEmailVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { assignOrgRole, createOrgRole, updateOrgRole } from "../organizationsController.js";
import { createOrgRoleSchema } from "../../lib/validate/organizationRoles.js";
import { getScopedDb } from "../../lib/context.js";

const mockGetScopedDb = vi.mocked(getScopedDb);

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ROLE_ID = "role-1";

function makeSdb(role: { base_tier: string; name: string } | null) {
	const tx = {
		technician: {
			update: vi.fn().mockResolvedValue(undefined),
			findFirst: vi.fn().mockResolvedValue({ id: USER_ID, organization_role_id: ROLE_ID }),
		},
		dispatcher: {
			update: vi.fn().mockResolvedValue(undefined),
			findFirst: vi.fn().mockResolvedValue({ id: USER_ID, organization_role_id: ROLE_ID }),
		},
	};
	const sdb = {
		organization_role: {
			findFirst: vi.fn().mockResolvedValue(role ? { id: ROLE_ID, organization_id: ORG_ID, ...role } : null),
		},
		technician: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID, organization_role_id: null }) },
		dispatcher: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID, organization_role_id: null }) },
		$transaction: vi.fn().mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx)),
		_tx: tx,
	};
	mockGetScopedDb.mockReturnValue(sdb as unknown as ReturnType<typeof getScopedDb>);
	return sdb;
}

describe("assignOrgRole — base_tier must match the user type", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("refuses to put a technician-tier role on a dispatcher", async () => {
		const sdb = makeSdb({ base_tier: "technician", name: "Field Tech" });
		const result = await assignOrgRole(USER_ID, "dispatcher", ROLE_ID, ORG_ID);

		expect(result.err).toMatch(/technician role.*cannot be assigned to a dispatcher/i);
		expect(sdb.$transaction).not.toHaveBeenCalled();
		expect(sdb._tx.dispatcher.update).not.toHaveBeenCalled();
	});

	it("refuses to put a dispatcher-tier role on a technician", async () => {
		const sdb = makeSdb({ base_tier: "dispatcher", name: "Coordinator" });
		const result = await assignOrgRole(USER_ID, "technician", ROLE_ID, ORG_ID);

		expect(result.err).toMatch(/dispatcher role.*cannot be assigned to a technician/i);
		expect(sdb._tx.technician.update).not.toHaveBeenCalled();
	});

	it("assigns a role whose tier matches the user type", async () => {
		const sdb = makeSdb({ base_tier: "dispatcher", name: "Coordinator" });
		const result = await assignOrgRole(USER_ID, "dispatcher", ROLE_ID, ORG_ID);

		expect(result.err).toBe("");
		expect(sdb._tx.dispatcher.update).toHaveBeenCalledWith({
			where: { id: USER_ID },
			data: { organization_role_id: ROLE_ID },
		});
	});

	it("still allows clearing the role (roleId null) without a tier check", async () => {
		const sdb = makeSdb(null);
		const result = await assignOrgRole(USER_ID, "technician", null, ORG_ID);

		expect(result.err).toBe("");
		expect(sdb.organization_role.findFirst).not.toHaveBeenCalled();
		expect(sdb._tx.technician.update).toHaveBeenCalledWith({
			where: { id: USER_ID },
			data: { organization_role_id: null },
		});
	});

	it("reports an unknown role before checking the tier", async () => {
		const sdb = makeSdb(null);
		const result = await assignOrgRole(USER_ID, "dispatcher", ROLE_ID, ORG_ID);

		expect(result.err).toBe("Role not found");
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});
});

/**
 * A role carrying another tier's permission is not inert: a technician role
 * holding dispute grants reaches the dispute routes as a caller separation of
 * duties cannot identify (DW-25).
 */
describe("role payloads are held to their tier's catalog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("refuses to create a technician role carrying dispute permissions", async () => {
		const sdb = makeSdb(null);
		const result = await createOrgRole(
			{ name: "Field Lead", base_tier: "technician", permissions: ["view_visits", "resolve_disputes"] },
			ORG_ID,
		);

		expect(result.err).toBe("Validation failed: Not technician permissions: resolve_disputes");
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("refuses a permission string no catalog defines", async () => {
		makeSdb(null);
		const result = await createOrgRole(
			{ name: "Clerk", base_tier: "dispatcher", permissions: ["approve_everything"] },
			ORG_ID,
		);

		expect(result.err).toMatch(/approve_everything/);
	});

	it("accepts a role whose permissions all belong to its tier", () => {
		expect(
			createOrgRoleSchema.safeParse({
				name: "Billing",
				base_tier: "dispatcher",
				permissions: ["view_invoices", "edit_invoices", "refund_invoices"],
			}).success,
		).toBe(true);
	});

	it("checks an update against the stored tier when the payload names none", async () => {
		const sdb = makeSdb({ base_tier: "technician", name: "Field Tech" });
		const result = await updateOrgRole(ROLE_ID, { permissions: ["concede_disputes"] }, ORG_ID);

		expect(result.err).toBe("Validation failed: Not technician permissions: concede_disputes");
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});
});
