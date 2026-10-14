import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("./harness.js");
	return { db: createFakeDb() };
});

// Only the guards and the history/limit plumbing are under test here; the
// heavy domain controllers the router wires up are stubbed out.
vi.mock("../../controllers/clientsController.js", () => ({
	getAllClients: vi.fn(), getClientById: vi.fn(), insertClient: vi.fn(), updateClient: vi.fn(), deleteClient: vi.fn(),
}));
vi.mock("../../controllers/contactsController.js", () => ({
	searchContacts: vi.fn(), getClientContacts: vi.fn(), getContactById: vi.fn(), getAllContacts: vi.fn(),
	insertContact: vi.fn(), updateContact: vi.fn(), deleteContact: vi.fn(), linkContactToClient: vi.fn(),
	updateClientContact: vi.fn(), unlinkContactFromClient: vi.fn(),
}));
vi.mock("../../controllers/clientNotesController.js", () => ({
	getClientNotes: vi.fn(), getNoteById: vi.fn(), insertNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
}));
vi.mock("../../controllers/jobsController.js", () => ({ getJobsByClientId: vi.fn() }));
vi.mock("../../controllers/quotesController.js", () => ({ getQuotesByClientId: vi.fn() }));
vi.mock("../../controllers/requestsController.js", () => ({ getRequestsByClientId: vi.fn() }));
vi.mock("../../controllers/invoicesController.js", () => ({ getInvoicesByClientId: vi.fn() }));
vi.mock("../../controllers/projectsController.js", () => ({
	getProjectsByClientId: vi.fn(async () => [{ id: "proj-1", name: "Roof", budget: "1000" }]),
}));

import clientsContactsRouter from "../clientsContacts.js";
import { db } from "../../db.js";
import { getProjectsByClientId } from "../../controllers/projectsController.js";
import { callRoute, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;

beforeEach(() => {
	vi.clearAllMocks();
	fake.log.findMany.mockResolvedValue([]);
	fake.log.count.mockResolvedValue(0);
	fake.client_note.findMany.mockResolvedValue([]);
	fake.client_contact.findMany.mockResolvedValue([]);
});

describe("GET /clients/:clientId/projects — technicians are hard-denied (review P2-12 / F5)", () => {
	it("returns 403 for a technician even with view_projects and view_clients", async () => {
		const r = await callRoute(clientsContactsRouter, "get", "/clients/:clientId/projects", {
			user: { uid: "tech-1", role: "technician", permissions: ["view_projects", "view_clients"] },
			params: { clientId: "client-1" },
		});
		expect(r.status).toBe(403);
		expect(getProjectsByClientId).not.toHaveBeenCalled();
	});

	it("returns 403 for a dispatcher with only view_clients", async () => {
		const r = await callRoute(clientsContactsRouter, "get", "/clients/:clientId/projects", {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_clients"] },
			params: { clientId: "client-1" },
		});
		expect(r.status).toBe(403);
		expect(getProjectsByClientId).not.toHaveBeenCalled();
	});

	it("returns the projects for a dispatcher with view_projects (and for admins)", async () => {
		const disp = await callRoute(clientsContactsRouter, "get", "/clients/:clientId/projects", {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_projects"] },
			params: { clientId: "client-1" },
		});
		expect(disp.status).toBe(200);
		expect(disp.body.data).toEqual([{ id: "proj-1", name: "Roof", budget: "1000" }]);
		expect(getProjectsByClientId).toHaveBeenCalledWith("org-1", "client-1");

		const admin = await callRoute(clientsContactsRouter, "get", "/clients/:clientId/projects", {
			user: { uid: "adm-1", role: "admin", permissions: [] },
			params: { clientId: "client-1" },
		});
		expect(admin.status).toBe(200);
	});
});

describe("GET /clients/:clientId/changes — limit validation (review P2-11)", () => {
	it.each(["-1", "0", "3.3", "nan", "999"])("returns 400 for limit=%s", async (limit) => {
		const r = await callRoute(clientsContactsRouter, "get", "/clients/:clientId/changes", {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_clients"] },
			params: { clientId: "client-1" },
			query: { limit },
		});
		expect(r.status).toBe(400);
		expect(r.body.error.code).toBe("VALIDATION_ERROR");
		expect(fake.log.findMany).not.toHaveBeenCalled();
	});

	it("returns history with meta for a valid limit", async () => {
		const r = await callRoute(clientsContactsRouter, "get", "/clients/:clientId/changes", {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_clients"] },
			params: { clientId: "client-1" },
			query: { limit: "7" },
		});
		expect(r.status).toBe(200);
		expect(r.body.meta).toMatchObject({ count: 0, hasMore: false, total: 0 });
		// the paged query is the last findMany; earlier ones resolve deleted children
		expect(fake.log.findMany.mock.calls.at(-1)![0].take).toBe(8);
	});
});
