import z from "zod";

export const registerOrganizationSchema = z.object({
	org_name:     z.string().min(1, "Organization name is required"),
	admin_name:   z.string().min(1, "Admin name is required"),
	admin_email:  z.string().email("Valid email is required"),
	admin_password: z.string().min(8, "Password must be at least 8 characters"),
	business_type: z.string().min(1, "Choose a business type"),
	admin_phone:  z.string().optional(),
	org_phone:    z.string().optional(),
	org_address:  z.string().optional(),
	org_website:  z.string().url("Must be a valid URL").optional().or(z.literal("")),
	org_timezone: z.string().optional(),
	org_tax_rate: z.number().min(0).max(1).optional(),
});

export type RegisterOrganizationInput = z.infer<typeof registerOrganizationSchema>;
