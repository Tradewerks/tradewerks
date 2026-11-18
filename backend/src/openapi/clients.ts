import z from "zod";
import {
	createClientSchema,
	updateClientSchema,
} from "../lib/validate/clients.js";
import {
	createContactSchema,
	updateContactSchema,
	linkContactSchema,
	updateClientContactSchema,
} from "../lib/validate/contacts.js";
import {
	createNoteSchema,
	updateNoteSchema,
} from "../lib/validate/clientNotes.js";
import {
	authed,
	client,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	json,
} from "./shared.js";

export { clientParams, noteAuthor, noteEditors };

// ===============================================================================================================================
// Clients & Contacts
// ===============================================================================================================================

authed("get", "/clients", "Clients", "view_clients", {
	summary: "List clients",
	description:
		"Requires the `view_clients` permission. Returns every client in the caller's organization, most recently active first.",
	responses: {
		200: json(envelope(z.array(client)), "Clients (empty array if none)"),
	},
});

authed("post", "/clients", "Clients", "create_clients", {
	summary: "Create a client",
	description:
		"Requires the `create_clients` permission. `coords` is looked up from `address` when omitted. Sending `qb_contact_email` or `qb_contact_phone` also creates a primary contact.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: createClientSchema.meta({ id: "CreateClient" }),
					example: {
						name: "Acme Heating",
						address: "123 Main St, Fargo, ND 58102",
					},
				},
			},
		},
	},
	responses: {
		201: json(envelope(client), "Client created"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
	},
});

authed("put", "/clients/{id}", "Clients", "edit_clients", {
	summary: "Update a client",
	description: "Requires the `edit_clients` permission.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: updateClientSchema.meta({ id: "UpdateClient" }),
					example: { name: "Acme Heating & Cooling" },
				},
			},
		},
	},
	responses: {
		200: json(envelope(client), "Client updated"),
		400: json(
			errorEnvelope,
			"Validation failed, or address couldn't be geocoded (`VALIDATION_ERROR`)",
		),
		404: json(errorEnvelope, "Client not found (`NOT_FOUND`)"),
		409: json(
			errorEnvelope,
			"Address change needs a tax choice: resend with `address_tax_choice` (`ADDRESS_TAX_CHOICE_REQUIRED`)",
		),
	},
});

authed("get", "/clients/{id}", "Clients", "view_clients", {
	summary: "Get a client",
	description: "Requires the `view_clients` permission.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(envelope(client), "Client"),
		404: json(
			errorEnvelope,
			"Client not in the caller's organization (`NOT_FOUND`)",
		),
	},
});

const noteAuthor = z
	.object({ id: z.uuid(), name: z.string(), email: z.string() })
	.nullable();

const clientNote = z
	.object({
		id: z.uuid(),
		client_id: z.uuid(),
		content: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		creator_tech: noteAuthor,
		creator_dispatcher: noteAuthor,
		client,
	})
	.meta({ id: "ClientNote" });

authed("post", "/clients/{id}/notes", "Clients", "edit_clients", {
	summary: "Add a note to a client",
	description:
		"Requires the `edit_clients` permission. The author is the caller, taken from the token.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: createNoteSchema
						.pick({ content: true })
						.meta({ id: "CreateNote" }),
					example: { content: "Gate code is 4412." },
				},
			},
		},
	},
	responses: {
		201: json(envelope(clientNote), "Note created"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(errorEnvelope, "Client not found (`NOT_FOUND`)"),
	},
});

const contact = z
	.object({
		id: z.uuid(),
		name: z.string(),
		email: z.string().nullable(),
		phone: z.string().nullable(),
		type: z.string().nullable(),
		is_active: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		client_contacts: z
			.array(
				z.object({
					client_id: z.uuid(),
					relationship: z.string(),
					is_primary: z.boolean(),
					is_billing: z.boolean(),
					client: z.object({ id: z.uuid(), name: z.string() }),
				}),
			)
			.optional(),
	})
	.meta({ id: "Contact" });

authed("get", "/contacts", "Contacts", "view_clients", {
	summary: "List contacts",
	description:
		"Requires the `view_clients` permission. Returns active contacts in the caller's organization, sorted by name, with the clients each is linked to.",
	responses: {
		200: json(envelope(z.array(contact)), "Contacts (empty array if none)"),
	},
});

authed("get", "/contacts/search", "Contacts", "view_clients", {
	summary: "Search contacts",
	description:
		"Requires the `view_clients` permission. Matches name, email or phone (case-insensitive) on active contacts. Returns at most 10, sorted by name.",
	request: {
		query: z.object({
			q: z
				.string()
				.describe(
					"Search text. Under 2 characters returns an empty array.",
				),
			exclude_client_id: z
				.uuid()
				.optional()
				.describe("Leave out contacts already linked to this client"),
		}),
	},
	responses: {
		200: json(
			envelope(
				z.array(
					z.object({
						id: z.uuid(),
						name: z.string(),
						email: z.string().nullable(),
						phone: z.string().nullable(),
					}),
				),
			),
			"Matching contacts",
		),
		500: json(errorEnvelope, "Search failed (`SERVER_ERROR`)"),
	},
});

authed("post", "/contacts", "Contacts", "create_clients", {
	summary: "Create a contact",
	description:
		"Requires the `create_clients` permission. Send `client_id` to link the new contact to a client.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: createContactSchema.meta({ id: "CreateContact" }),
					example: {
						name: "Jane Doe",
						email: "jane@example.com",
						phone: "555-0100",
					},
				},
			},
		},
	},
	responses: {
		201: json(envelope(contact), "Contact created"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(
			errorEnvelope,
			"`client_id` not in the caller's organization (`NOT_FOUND`)",
		),
		409: json(
			errorEnvelope,
			"A contact with this email or phone already exists; `error.details` holds it (`VALIDATION_ERROR`)",
		),
	},
});

authed("put", "/contacts/{id}", "Contacts", "edit_clients", {
	summary: "Update a contact",
	description:
		"Requires the `edit_clients` permission. Send at least one field.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: updateContactSchema.meta({ id: "UpdateContact" }),
					example: { phone: "555-0199" },
				},
			},
		},
	},
	responses: {
		200: json(envelope(contact), "Contact updated"),
		400: json(
			errorEnvelope,
			"Validation failed, or another contact has this email or phone (`VALIDATION_ERROR`)",
		),
		404: json(errorEnvelope, "Contact not found (`VALIDATION_ERROR`)"),
	},
});

authed("delete", "/clients/{id}", "Clients", "delete_clients", {
	summary: "Delete a client",
	description:
		"Requires the `delete_clients` permission. Blocked while the client has jobs, projects, recurring plans, requests, quotes or invoices, or is linked to QuickBooks; mark it inactive instead. Its notes are deleted with it; its contacts are unlinked, not deleted.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(
			envelope(z.object({ message: z.string(), id: z.uuid() })),
			"Client deleted",
		),
		400: json(
			errorEnvelope,
			"Client still has related records (`DELETE_ERROR`)",
		),
		404: json(errorEnvelope, "Client not found (`NOT_FOUND`)"),
	},
});

authed("get", "/contacts/{id}", "Contacts", "view_clients", {
	summary: "Get a contact",
	description:
		"Requires the `view_clients` permission. Also includes `client_contacts`: each linked client's `id` and `name` with the link's relationship and flags.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(envelope(contact), "Contact"),
		404: json(
			errorEnvelope,
			"Contact not in the caller's organization (`NOT_FOUND`)",
		),
	},
});

authed("delete", "/contacts/{id}", "Contacts", "delete_clients", {
	summary: "Delete a contact",
	description:
		"Requires the `delete_clients` permission. Blocked while the contact is linked to any client; unlink it first or mark it inactive.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(
			envelope(z.object({ message: z.string() })),
			"Contact deleted",
		),
		400: json(
			errorEnvelope,
			"Contact is still linked to a client (`DELETE_ERROR`)",
		),
		404: json(errorEnvelope, "Contact not found (`DELETE_ERROR`)"),
	},
});

const clientParams = z.object({ clientId: z.uuid() });
const clientNoteParams = clientParams.extend({ noteId: z.uuid() });
const clientContactParams = clientParams.extend({ contactId: z.uuid() });
const noteEditors = {
	last_editor_tech: noteAuthor,
	last_editor_dispatcher: noteAuthor,
};
const clientNoteRow = clientNote.omit({ client: true }).extend(noteEditors);
const clientContactLink = z
	.object({
		id: z.uuid(),
		client_id: z.uuid(),
		contact_id: z.uuid(),
		relationship: z.string(),
		is_primary: z.boolean(),
		is_billing: z.boolean(),
		created_at: z.iso.datetime(),
	})
	.meta({ id: "ClientContactLink" });

authed("get", "/clients/{clientId}/contacts", "Clients", "view_clients", {
	summary: "List a client's contacts",
	description:
		"Requires the `view_clients` permission. Each link with its full `contact`, sorted by contact name. An unknown client returns an empty array.",
	request: { params: clientParams },
	responses: {
		200: json(
			envelope(
				z.array(
					clientContactLink.extend({
						contact: contact.omit({ client_contacts: true }),
					}),
				),
			),
			"Contact links (empty array if none)",
		),
	},
});

authed("post", "/clients/{clientId}/contacts/link", "Clients", "edit_clients", {
	summary: "Link a contact to a client",
	description:
		"Requires the `edit_clients` permission. Updates the client's last activity.",
	request: {
		params: clientParams,
		body: {
			content: {
				"application/json": {
					schema: linkContactSchema
						.extend({ contact_id: z.uuid() })
						.meta({ id: "LinkContact" }),
				},
			},
		},
	},
	responses: {
		201: json(envelope(clientContactLink), "Contact linked"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(
			errorEnvelope,
			"Contact or client not found (`VALIDATION_ERROR`)",
		),
		409: json(
			errorEnvelope,
			"Contact already linked to this client (`VALIDATION_ERROR`)",
		),
	},
});

authed(
	"put",
	"/clients/{clientId}/contacts/{contactId}/relationship",
	"Clients",
	"edit_clients",
	{
		summary: "Update a contact link",
		description:
			"Requires the `edit_clients` permission. Send at least one of `relationship`, `is_primary` or `is_billing`.",
		request: {
			params: clientContactParams,
			body: {
				content: {
					"application/json": {
						schema: updateClientContactSchema.meta({
							id: "UpdateClientContact",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(clientContactLink), "Link updated"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Contact not linked to this client (`VALIDATION_ERROR`)",
			),
		},
	},
);

authed(
	"delete",
	"/clients/{clientId}/contacts/{contactId}/link",
	"Clients",
	"edit_clients",
	{
		summary: "Unlink a contact from a client",
		description:
			"Requires the `edit_clients` permission. The contact itself is kept.",
		request: { params: clientContactParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Contact unlinked",
			),
			404: json(
				errorEnvelope,
				"Contact not linked to this client (`DELETE_ERROR`)",
			),
		},
	},
);

authed("get", "/clients/{clientId}/notes", "Clients", "view_clients", {
	summary: "List a client's notes",
	description:
		"Requires the `view_clients` permission. Newest first. An unknown client returns an empty array.",
	request: { params: clientParams },
	responses: {
		200: json(
			envelope(z.array(clientNoteRow)),
			"Notes (empty array if none)",
		),
	},
});

authed("get", "/clients/{clientId}/notes/{noteId}", "Clients", "view_clients", {
	summary: "Get a client note",
	description: "Requires the `view_clients` permission.",
	request: { params: clientNoteParams },
	responses: {
		200: json(envelope(clientNoteRow), "Note"),
		404: json(errorEnvelope, "Note not found on this client (`NOT_FOUND`)"),
	},
});

authed("put", "/clients/{clientId}/notes/{noteId}", "Clients", "edit_clients", {
	summary: "Update a client note",
	description:
		"Requires the `edit_clients` permission. Any user with the permission can edit any note; the caller is recorded as the last editor.",
	request: {
		params: clientNoteParams,
		body: {
			content: {
				"application/json": {
					schema: updateNoteSchema
						.pick({ content: true })
						.meta({ id: "UpdateNote" }),
				},
			},
		},
	},
	responses: {
		200: json(envelope(clientNoteRow), "Note updated"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(errorEnvelope, "Note not found (`NOT_FOUND`)"),
	},
});

authed(
	"delete",
	"/clients/{clientId}/notes/{noteId}",
	"Clients",
	"edit_clients",
	{
		summary: "Delete a client note",
		description:
			"Requires the `edit_clients` permission. Any user with the permission can delete any note.",
		request: { params: clientNoteParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Note deleted",
			),
			404: json(errorEnvelope, "Note not found (`NOT_FOUND`)"),
		},
	},
);

authed("get", "/clients/{clientId}/changes", "Clients", "view_clients", {
	summary: "Get a client's history",
	description:
		"Requires the `view_clients` permission. Activity on the client, its notes and its linked contacts.",
	request: { params: clientParams, query: historyQuery },
	responses: historyResponses,
});
