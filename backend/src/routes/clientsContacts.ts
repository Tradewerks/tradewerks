import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router } from 'express';
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import { getUserContext } from "../lib/context.js";
import { isAddressTaxChoiceRefusal } from "../lib/addressTaxChoice.js";
import {
	getAllClients,
	getClientById,
	insertClient,
	updateClient,
	deleteClient,
} from "../controllers/clientsController.js";
import {
	searchContacts,
	getClientContacts,
	getContactById,
	getAllContacts,
	insertContact,
	updateContact,
	deleteContact,
	linkContactToClient,
	updateClientContact,
	unlinkContactFromClient,
} from "../controllers/contactsController.js";
import {
	getClientNotes,
	getNoteById,
	insertNote,
	updateNote,
	deleteNote,
} from "../controllers/clientNotesController.js";
import { getJobsByClientId } from "../controllers/jobsController.js";
import { getQuotesByClientId } from '../controllers/quotesController.js';
import { getRequestsByClientId } from '../controllers/requestsController.js';
import * as invoicesController from '../controllers/invoicesController.js';
import { requirePermission, requireAnyPermission, denyTechnicians } from '../lib/requirePermissions.js';
import { getProjectsByClientId } from '../controllers/projectsController.js';
import { getEntityHistory, parseHistoryLimit, INVALID_HISTORY_LIMIT } from '../controllers/logsController.js';

const router = Router();

// ============================================
// CLIENTS
// ============================================

router.get("/clients", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const clients = await getAllClients(orgId);
        res.json(createSuccessResponse(clients, { count: clients.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/clients/:id", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const client = await getClientById(id, orgId);

        if (!client) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Client not found",
                    ),
                );
        }

        res.json(createSuccessResponse(client));
    } catch (err) {
        next(err);
    }
});

router.post("/clients", requirePermission("create_clients"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertClient(req.body, orgId, context);

        if (result.err) {
            const isDuplicate = result.err
                .toLowerCase()
                .includes("already exists");
            return res
                .status(isDuplicate ? 409 : 400)
                .json(
                    createErrorResponse(
                        isDuplicate
                            ? ErrorCodes.CONFLICT
                            : ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/clients/:id", requirePermission("edit_clients"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateClient(id, req.body, orgId, context);

        if (isAddressTaxChoiceRefusal(result)) {
            return res
                .status(409)
                .json(createErrorResponse(result.code, result.err, result.details));
        }
        if (result.err) {
            const isDuplicate = result.err
                .toLowerCase()
                .includes("already exists");
            return res
                .status(isDuplicate ? 409 : 400)
                .json(
                    createErrorResponse(
                        isDuplicate
                            ? ErrorCodes.CONFLICT
                            : ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/clients/:id", requirePermission("delete_clients"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteClient(id, orgId, context);

        if (result.err) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }

        res.status(200).json(
            createSuccessResponse({
                message: result.message || "Client deleted successfully",
                id,
            }),
        );
    } catch (err) {
        next(err);
    }
});

// Quotes for a client
router.get("/clients/:clientId/quotes", requireModule("quotes"), requirePermission("view_clients"), async (req, res, next) => {
	try {
		const clientId = req.params.clientId as string;
		const orgId = req.user!.organization_id as string;
		const quotes = await getQuotesByClientId(clientId, orgId);
		res.json(createSuccessResponse(quotes, { count: quotes.length }));
	} catch (err) {
		next(err);
	}
});

// requests for a client
router.get("/clients/:clientId/requests", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const clientId = req.params.clientId as string;
        const orgId = req.user!.organization_id as string;
        const requests = await getRequestsByClientId(clientId, orgId);
        res.json(createSuccessResponse(requests, { count: requests.length }));
    } catch (err) {
        next(err);
    }
});

// invoices for a client
router.get("/clients/:clientId/invoices", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const invoices = await invoicesController.getInvoicesByClientId(
            req.params.clientId as string,
            orgId,
        );
        res.json(createSuccessResponse(invoices, { count: invoices.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/clients/:clientId/changes", requirePermission("view_clients"), async (req, res, next)=> {
    try {
        const orgId = req.user!.organization_id as string;
        const clientId = req.params.clientId as string;
        let limit: number;
        try {
            limit = parseHistoryLimit(req.query.limit);
        } catch {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
        }

        const results = await getEntityHistory(orgId, "client", clientId, limit);

        if (results.err) {
            return res
                .status(500)
                .json(createErrorResponse(ErrorCodes.SERVER_ERROR, results.err));
        }

        res.json(createSuccessResponse(results.rows, {
            count: results.rows.length,
            hasMore: results.hasMore,
            total: results.total,
        }));
    } catch (err) {
        next(err);
    }
})

// ============================================
// CONTACTS
// ============================================

// Search contacts
router.get("/contacts/search", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const { q, exclude_client_id } = req.query;
        const orgId = req.user!.organization_id as string;

        const result = await searchContacts(
            q as string,
            orgId,
            exclude_client_id as string | undefined,
        );

        if (result.err) {
            return res
                .status(500)
                .json(createErrorResponse(ErrorCodes.SERVER_ERROR, result.err));
        }

        res.status(200).json(createSuccessResponse(result.items));
    } catch (err) {
        next(err);
    }
});

router.get("/clients/:clientId/contacts", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const clientId = req.params.clientId as string;
        const contacts = await getClientContacts(clientId, req.user!.organization_id as string);
        res.json(createSuccessResponse(contacts, { count: contacts.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/contacts/:contactId", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const contactId = req.params.contactId as string;
        const orgId = req.user!.organization_id as string;
        const contact = await getContactById(contactId, orgId);

        if (!contact) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Contact not found",
                    ),
                );
        }

        res.json(createSuccessResponse(contact));
    } catch (err) {
        next(err);
    }
});

router.get("/contacts", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const contacts = await getAllContacts(orgId);
        res.json(createSuccessResponse(contacts, { count: contacts.length }));
    } catch (err) {
        next(err);
    }
});

router.post("/contacts", requirePermission("create_clients"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertContact(req.body, orgId, context);

        if (result.err) {
            const statusCode = result.existingContact ? 409 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                        result.existingContact,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// Update an independent contact
router.put("/contacts/:contactId", requirePermission("edit_clients"), async (req, res, next) => {
    try {
        const contactId = req.params.contactId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateContact(contactId, req.body, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// Delete an independent contact (only if not linked)
router.delete("/contacts/:contactId", requirePermission("delete_clients"), async (req, res, next) => {
    try {
        const contactId = req.params.contactId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteContact(contactId, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }

        res.status(200).json(
            createSuccessResponse({ message: result.message }),
        );
    } catch (err) {
        next(err);
    }
});

// Link an existing contact to a client
router.post("/clients/:clientId/contacts/link", requirePermission("edit_clients"), async (req, res, next) => {
    try {
        const clientId = req.params.id as string;
        const { contact_id, relationship, is_primary, is_billing } = req.body;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);

        const result = await linkContactToClient(
            contact_id,
            clientId,
            { relationship, is_primary, is_billing },
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found")
                ? 404
                : result.err.includes("already linked")
                    ? 409
                    : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// Update a client-contact relationship
router.put(
    "/clients/:clientId/contacts/:contactId/relationship",
    requirePermission("edit_clients"),
    async (req, res, next) => {
        try {
            const { clientId, contactId } = req.params as { clientId: string; contactId: string };
            const context = getUserContext(req);
            const result = await updateClientContact(
                contactId,
                clientId,
                req.body,
                req.user!.organization_id as string,
                context,
            );

            if (result.err) {
                const statusCode = result.err.includes("not linked")
                    ? 404
                    : 400;
                return res
                    .status(statusCode)
                    .json(
                        createErrorResponse(
                            ErrorCodes.VALIDATION_ERROR,
                            result.err,
                        ),
                    );
            }

            res.json(createSuccessResponse(result.item));
        } catch (err) {
            next(err);
        }
    },
);

// Unlink a contact from a client
router.delete(
    "/clients/:clientId/contacts/:contactId/link",
    requirePermission("edit_clients"),
    async (req, res, next) => {
        try {
            const { clientId, contactId } = req.params as { clientId: string; contactId: string };
            const context = getUserContext(req);
            const result = await unlinkContactFromClient(
                contactId,
                clientId,
                req.user!.organization_id as string,
                context,
            );

            if (result.err) {
                const statusCode = result.err.includes("not linked")
                    ? 404
                    : 400;
                return res
                    .status(statusCode)
                    .json(
                        createErrorResponse(
                            ErrorCodes.DELETE_ERROR,
                            result.err,
                        ),
                    );
            }

            res.status(200).json(
                createSuccessResponse({ message: result.message }),
            );
        } catch (err) {
            next(err);
        }
    },
);

// ============================================
// CLIENT NOTES
// ============================================

router.get("/clients/:clientId/notes", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const clientId = req.params.clientId as string;
        const orgId = req.user!.organization_id as string;
        const notes = await getClientNotes(clientId, orgId);
        res.json(createSuccessResponse(notes, { count: notes.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/clients/:clientId/notes/:noteId", requirePermission("view_clients"), async (req, res, next) => {
    try {
        const { clientId, noteId } = req.params as { clientId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const note = await getNoteById(clientId, noteId, orgId);

        if (!note) {
            return res
                .status(404)
                .json(
                    createErrorResponse(ErrorCodes.NOT_FOUND, "Note not found"),
                );
        }

        res.json(createSuccessResponse(note));
    } catch (err) {
        next(err);
    }
});

router.post("/clients/:clientId/notes", requirePermission("edit_clients"), async (req, res, next) => {
    try {
        const clientId = req.params.clientId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertNote(clientId, req.body, orgId, context);

        if (result.err) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/clients/:clientId/notes/:noteId", requirePermission("edit_clients"), async (req, res, next) => {
    try {
        const { clientId, noteId } = req.params as { clientId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateNote(clientId, noteId, req.body, orgId, context);

        if (result.err) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/clients/:clientId/notes/:noteId", requirePermission("edit_clients"), async (req, res, next) => {
    try {
        const { clientId, noteId } = req.params as { clientId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteNote(clientId, noteId, orgId, context);

        if (result.err) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }

        res.status(200).json(
            createSuccessResponse({
                message: result.message || "Note deleted successfully",
            }),
        );
    } catch (err) {
        next(err);
    }
});

// ============================================
// CLIENT JOBS (Read-only)
// ============================================

router.get("/clients/:clientId/jobs", requireAnyPermission("view_clients", "view_jobs"), async (req, res, next) => {
    try {
        const clientId = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const jobs = await getJobsByClientId(clientId, orgId);
        res.json(createSuccessResponse(jobs, { count: jobs.length }));
    } catch (err) {
        next(err);
    }
});

// ============================================
// CLIENT PROJECTS (Read-only)
// ============================================
// Same policy as /projects: technicians are hard-denied and dispatchers need
// view_projects (project budgets are not part of the client view).
router.get("/clients/:clientId/projects", requireModule("projects"), denyTechnicians, requirePermission("view_projects"), async (req, res, next) => {
    try {
        const clientId = req.params.clientId as string;
        const orgId = req.user!.organization_id as string;
        const result = await getProjectsByClientId(orgId, clientId);

        res.json(createSuccessResponse(result));
    } catch (err) {
        next(err);
    }
});

export default router;
