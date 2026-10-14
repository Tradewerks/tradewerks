import { describe, it, expect, vi } from "vitest";

// db.ts constructs a PrismaClient at import; the adapter must not try to connect.
// Path is relative to THIS file: generated/ lives at the backend root, two
// levels up from src/__tests__ (db.ts itself is one level up from src/).
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../../generated/prisma/client.js", () => ({ PrismaClient: vi.fn() }));

import { SECRET_FIELD_OMIT } from "../db.js";

describe("SECRET_FIELD_OMIT", () => {
	it("withholds technician pay rate from every default read", () => {
		// Nested `visit_techs: { include: { tech: true } }` reads reach any caller
		// of the visit endpoints, including technicians viewing co-workers.
		expect(SECRET_FIELD_OMIT.technician).toMatchObject({
			password: true,
			password_reset_token: true,
			password_reset_token_expires_at: true,
			hourly_rate: true,
		});
	});
});
