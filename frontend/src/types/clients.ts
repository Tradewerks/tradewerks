import z from "zod";
import type { Coordinates } from "./location";
import type { AddressTaxChoice } from "./tax";
import type { RequestSummary, QuoteSummary, JobSummary } from "./common";

// ============================================================================
// SUMMARY TYPES
// ============================================================================

export interface RecurringPlanSummary {
	id: string;
	name: string;
	status: string;
	starts_at: Date | string;
	created_at: Date | string;
}

export interface ClientNoteSummary {
	id: string;
	content: string;
	created_at: Date | string;
	updated_at: Date | string;
}

export interface ContactInfo {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	type: string | null;
}

export interface ClientContactLink {
	client_id: string;
	contact_id: string;
	relationship: string;
	is_primary: boolean;
	is_billing: boolean;
	contact: Contact;
}

// ============================================================================
// CLIENT TYPES
// ============================================================================

export interface Client {
	id: string;
	name: string;
	address: string;
	coords: Coordinates;
	is_active: boolean;
	is_tax_exempt: boolean;
	tax_group_id: string | null;
	created_at: Date | string;
	last_activity: Date | string;

	jobs: JobSummary[];
	quotes: QuoteSummary[];
	requests: RequestSummary[];
	recurring_plans: RecurringPlanSummary[];
	contacts: ClientContactLink[];
	notes: ClientNoteSummary[];
}

export interface QBCustomerLite {
  Id: string;
  DisplayName: string;

  PrimaryEmailAddr?: {
    Address: string;
  };

  PrimaryPhone? : { FreeFormNumber?: string }
  GivenName?: string
  FamilyName?: string

  BillAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
    Country?: string;
  };

  Active?: boolean;

  MetaData?: {
    CreateTime?: string;
    LastUpdatedTime?: string;
  };
}

export interface ClientSummary {
	id: string;
	name: string;
	address: string;
	is_active: boolean;
}

export interface ClientWithPrimaryContact {
	id: string;
	name: string;
	address: string;
	coords?: Coordinates;
	is_active: boolean;
	is_tax_exempt?: boolean;
	tax_group_id?: string | null;
	contacts?: {
		is_primary: boolean;
		contact: ContactInfo;
	}[];
}

// ============================================================================
// CLIENT INPUT TYPES
// ============================================================================

export interface CreateClientInput {
	name: string;
	address: string;
	coords: Coordinates;
	is_active?: boolean;
	qb_customer_id?: string;
	qb_contact_name?: string
	qb_contact_email?: string
	qb_contact_phone?: string
}

export interface UpdateClientInput {
	name?: string;
	address?: string;
	coords?: Coordinates;
	is_active?: boolean;
	address_tax_choice?: AddressTaxChoice;
}

export const CreateClientSchema = z.object({
	name: z.string().min(1, "Client name is required").max(128, "Client name must be 128 characters or fewer"),
	address: z.string().min(1, "Address is required"),
	coords: z.object({
		lat: z.number(),
		lon: z.number(),
	}),
	is_active: z.boolean().default(true),
});

export const UpdateClientSchema = z.object({
	name: z.string().min(1, "Client name is required").max(128, "Client name must be 128 characters or fewer").optional(),
	address: z.string().min(1, "Address is required").optional(),
	coords: z
		.object({
			lat: z.number(),
			lon: z.number(),
		})
		.optional(),
	is_active: z.boolean().optional(),
});

// ============================================================================
// CONTACT TYPES
// ============================================================================

export interface Contact {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	type: string | null;
	is_active: boolean;
	created_at: Date | string;
	updated_at: Date | string;
	client_contacts: ClientContactLink[];
}

export interface CreateContactInput {
	name: string;
	email?: string;
	phone?: string;
	type?: string;
	client_id?: string;
	relationship?: string;
	is_primary?: boolean;
	is_billing?: boolean;
}

export interface UpdateContactInput {
	name?: string;
	email?: string;
	phone?: string;
	type?: string;
	is_active?: boolean;
}

export interface LinkContactInput {
	contact_id: string;
	relationship: string;
	is_primary: boolean;
	is_billing: boolean;
}

export interface UpdateClientContactInput {
	relationship?: string;
	is_primary?: boolean;
	is_billing?: boolean;
}

export const CreateContactSchema = z.object({
	name: z.string().min(1, "Contact name is required"),
	email: z.string().email("Invalid email address").optional().or(z.literal("")),
	phone: z.string().optional().or(z.literal("")),
	type: z.string().optional().or(z.literal("")),
	client_id: z.string().uuid().optional(),
	relationship: z.string().optional(),
	is_primary: z.boolean().optional(),
	is_billing: z.boolean().optional(),
});

export const UpdateContactSchema = z
	.object({
		name: z.string().min(1, "Contact name is required").optional(),
		email: z.string().email("Invalid email address").optional().or(z.literal("")),
		phone: z.string().optional().or(z.literal("")),
		type: z.string().optional().or(z.literal("")),
		is_active: z.boolean().optional(),
	})
	.refine(
		(data) =>
			data.name !== undefined ||
			data.email !== undefined ||
			data.phone !== undefined ||
			data.type !== undefined ||
			data.is_active !== undefined,
		{ message: "At least one field must be provided for update" }
	);

export const LinkContactSchema = z.object({
	contact_id: z.string().uuid("Invalid contact ID"),
	relationship: z.string().min(1, "Relationship is required").default("contact"),
	is_primary: z.boolean().default(false),
	is_billing: z.boolean().default(false),
});

export const UpdateClientContactSchema = z
	.object({
		relationship: z.string().optional(),
		is_primary: z.boolean().optional(),
		is_billing: z.boolean().optional(),
	})
	.refine(
		(data) =>
			data.relationship !== undefined ||
			data.is_primary !== undefined ||
			data.is_billing !== undefined,
		{ message: "At least one field must be provided for update" }
	);

// ============================================================================
// CLIENT NOTE TYPES
// ============================================================================

export interface ClientNote {
	id: string;
	client_id: string;
	content: string;
	created_at: Date | string;
	updated_at: Date | string;

	creator_tech_id: string | null;
	creator_dispatcher_id: string | null;
	creator_tech?: { id: string; name: string; email: string };
	creator_dispatcher?: { id: string; name: string; email: string };

	last_editor_tech_id: string | null;
	last_editor_dispatcher_id: string | null;
	last_editor_tech?: { id: string; name: string; email: string };
	last_editor_dispatcher?: { id: string; name: string; email: string };
}

export interface CreateClientNoteInput {
	content: string;
}

export interface UpdateClientNoteInput {
	content: string;
}

export const CreateClientNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

export const UpdateClientNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

// ============================================================================
// Conversion Function
// ============================================================================

export function mapQbCustomerToClient(qb: QBCustomerLite): Client {
  return {
    id: qb.Id,
    name: qb.DisplayName,

    address: qb.BillAddr
      ? `${qb.BillAddr.Line1 ?? ""}, ${qb.BillAddr.City ?? ""}, ${qb.BillAddr.CountrySubDivisionCode ?? ""} ${qb.BillAddr.PostalCode ?? ""}`.trim()
      : "",

    coords: {
      lat: 0, // QuickBooks does NOT provide coordinates
      lon: 0,
    },

    is_active: qb.Active ?? true,
    is_tax_exempt: false, // QuickBooks doesn't reliably model this in Customer
    tax_group_id: null,

    created_at: qb.MetaData?.CreateTime ?? new Date().toISOString(),
    last_activity: qb.MetaData?.LastUpdatedTime ?? new Date().toISOString(),

    jobs: [],
    quotes: [],
    requests: [],
    recurring_plans: [],
    contacts: [],
    notes: [],
  };
}