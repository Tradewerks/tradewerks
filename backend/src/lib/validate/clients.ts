import z from "zod";
import { coordsSchema } from "./shared.js";

export const createClientSchema = z.object({
	name: z.string().min(1, "Client name is required"),
	address: z.string().min(1, "Client address is required"),
	coords: coordsSchema.optional(), // filled from address by fillCoords when omitted
	is_active: z.boolean().optional().default(true),
	qb_customer_id: z.string().optional(),
	qb_contact_name: z.string().optional(),
	qb_contact_email: z.string().optional(),
	qb_contact_phone: z.string().optional(),
});

export const updateClientSchema = z
	.object({
		name: z.string().min(1, "Client name is required").optional(),
		address: z.string().min(1, "Address is required").optional(),
		coords: coordsSchema.optional(),
		is_active: z.boolean().optional(),
	})
	.refine(
		(data) =>
			data.name !== undefined ||
			data.address !== undefined ||
			data.coords !== undefined ||
			data.is_active !== undefined,
		{ message: "At least one field must be provided for update" },
	);

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
