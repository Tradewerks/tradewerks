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
	// Self-serve signup is US-only (lib/signupRegion.ts); the IP check cannot see past a VPN.
	us_business_confirmed: z.literal(true, {
		error: "Confirm that your business is located in the United States",
	}),
});

export type RegisterOrganizationInput = z.infer<typeof registerOrganizationSchema>;

const isHttps = (value: string) => {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
};

/** The org's public review page; blank clears it. */
export const reviewUrlSchema = z.preprocess(
	(v) => (typeof v === "string" && v.trim() === "" ? null : v),
	z
		.string()
		.trim()
		.max(500, "The review link is too long")
		.refine(isHttps, "The review link must be a full https:// address")
		.nullable(),
);
