import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(), getUserContext: vi.fn() }));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn() }));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/emailService.js", () => ({ sendEmailVerificationEmail: vi.fn() }));

import { defaultDispatcherPermissions } from "../organizationsController.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
	resolve(
		here,
		"../../../prisma/migrations/20260909120000_dispute_role_permissions/migration.sql",
	),
	"utf8",
);

/** The WHERE predicate of the UPDATE that grants `permission`, or null. */
function grantPredicate(permission: string): string | null {
	const statements = migrationSql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((s) => s.trim());
	const grant = statements.find((s) =>
		s.includes(`"permissions" || ARRAY['${permission}']`),
	);
	return grant ? grant.slice(grant.indexOf("WHERE")) : null;
}

/**
 * A new org's Default Dispatcher must receive what an existing org's
 * equivalent role receives from the dispute-role migration (audit DW-05, D2).
 * Without this, SoD is off in every org created after deploy.
 */
describe("Default Dispatcher template follows the dispute-role migration", () => {
	const template = defaultDispatcherPermissions();

	it("withholds dispute resolution, concession and self-resolution", () => {
		expect(template).not.toContain("resolve_disputes");
		expect(template).not.toContain("concede_disputes");
		expect(template).not.toContain("resolve_own_disputes");
	});

	it("keeps refund_invoices alongside edit_invoices", () => {
		expect(template).toContain("edit_invoices");
		expect(template).toContain("refund_invoices");
	});

	it("still withholds administration", () => {
		for (const p of ["manage_roles", "view_admin", "manage_organization", "manage_dispatchers"]) {
			expect(template).not.toContain(p);
		}
	});

	it("matches the migration: refund follows edit_invoices, resolve/concede follow administration only", () => {
		expect(grantPredicate("refund_invoices")).toContain("'edit_invoices'");
		for (const p of ["resolve_disputes", "concede_disputes"]) {
			const where = grantPredicate(p);
			expect(where).not.toBeNull();
			expect(where).not.toContain("edit_");
		}
		expect(grantPredicate("resolve_own_disputes")).toBeNull();
	});
});

const sendMigrationSql = readFileSync(
	resolve(
		here,
		"../../../prisma/migrations/20260915120000_send_document_permissions/migration.sql",
	),
	"utf8",
);

/** The WHERE predicate of the send-migration UPDATE granting `permission`. */
function sendGrantPredicate(permission: string): string | null {
	const statements = sendMigrationSql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((s) => s.trim());
	const grant = statements.find((s) =>
		s.includes(`"permissions" || ARRAY['${permission}']`),
	);
	return grant ? grant.slice(grant.indexOf("WHERE")) : null;
}

/**
 * Same rule as refund_invoices: send_* re-gates an act that already lived behind
 * edit_*, so granting it only to administrators would silently take sending away
 * from every role that has it today. It follows edit_* on deploy day; narrowing
 * from there is the owner's visible choice in the roles editor.
 */
describe("Default Dispatcher template follows the send-permission migration", () => {
	const template = defaultDispatcherPermissions();

	it("grants send_quotes and send_invoices to a new org's default role", () => {
		expect(template).toContain("send_quotes");
		expect(template).toContain("send_invoices");
	});

	it("matches the migration: send follows the matching edit permission", () => {
		expect(sendGrantPredicate("send_quotes")).toContain("'edit_quotes'");
		expect(sendGrantPredicate("send_invoices")).toContain("'edit_invoices'");
	});

	// Sending is a dispatcher-tier act. A technician catalog that picked these
	// up would put client-facing email behind a field permission.
	it("stays off the technician tier", () => {
		const migration = sendMigrationSql.replace(/--[^\n]*/g, "");
		expect(migration).not.toContain("'technician'");
	});
});
