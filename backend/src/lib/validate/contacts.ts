import z from "zod";

// ============================================================================
// CONTACT SCHEMAS (Independent Contact Model)
// ============================================================================

export const createContactSchema = z.object({
	name: z.string().min(1, "Contact name is required"),
	email: z
		.string()
		.email("Invalid email address")
		.optional()
		.or(z.literal("")),
	phone: z.string().optional().or(z.literal("")),
	type: z.string().optional().or(z.literal("")), // "customer", "vendor", "property_manager", "tenant"

	// Optional client linking (creates client_contact record)
	client_id: z.string().uuid().optional(),
	relationship: z.string().optional(), // "owner", "tenant", "manager", "emergency_contact"
	is_primary: z.boolean().optional(),
	is_billing: z.boolean().optional(),
});

export const updateContactSchema = z
	.object({
		name: z.string().min(1, "Contact name is required").optional(),
		email: z
			.string()
			.email("Invalid email address")
			.optional()
			.or(z.literal("")),
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

export const linkContactSchema = z.object({
	relationship: z
		.string()
		.min(1, "Relationship is required")
		.default("contact"),
	is_primary: z.boolean().default(false),
	is_billing: z.boolean().default(false),
});

export const updateClientContactSchema = z
	.object({
		relationship: z.string().optional(),
		is_primary: z.boolean().optional(),
		is_billing: z.boolean().optional(),
		notify_visits: z.boolean().optional(),
	})
	.refine(
		(data) =>
			data.relationship !== undefined ||
			data.is_primary !== undefined ||
			data.is_billing !== undefined ||
			data.notify_visits !== undefined,
		{ message: "At least one field must be provided for update" }
	);

export const setContactConsentSchema = z.object({
	channel: z.enum(["email", "sms"]),
	status: z.enum(["subscribed", "unsubscribed"]),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type LinkContactInput = z.infer<typeof linkContactSchema>;
export type UpdateClientContactInput = z.infer<
	typeof updateClientContactSchema
>;
