import { z } from "zod";

// Mirrors backend/src/lib/validate/smsAccount.ts; the server re-checks everything.
export const SMS_ENTITY_TYPES = [
	"Sole Proprietorship",
	"Partnership",
	"Limited Liability Corporation",
	"Co-operative",
	"Non-profit Corporation",
	"Corporation",
] as const;

export const SMS_VERTICALS: readonly { value: string; label: string }[] = [
	{ value: "CONSTRUCTION", label: "Construction and trades" },
	{ value: "PROFESSIONAL_SERVICES", label: "Professional services" },
	{ value: "ENERGY", label: "Energy" },
	{ value: "ENGINEERING", label: "Engineering" },
	{ value: "REAL_ESTATE", label: "Real estate" },
	{ value: "RETAIL", label: "Retail" },
	{ value: "AUTOMOTIVE", label: "Automotive" },
	{ value: "MANUFACTURING", label: "Manufacturing" },
];

const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;

/** Same rule as the backend's toE164: a 10-digit NANP number, optional +1/1 and extension. */
export function isNanpPhone(raw: string): boolean {
	const main = raw.split(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i)[0].trim();
	if (!/^\+?[\d\s().-]+$/.test(main)) return false;
	let digits = main.replace(/\D/g, "");
	if (main.startsWith("+")) {
		if (!digits.startsWith("1")) return false;
		digits = digits.slice(1);
	} else if (digits.length === 11 && digits.startsWith("1")) {
		digits = digits.slice(1);
	}
	return NANP.test(digits);
}

const required = (max = 255) =>
	z.string().trim().min(1, "Required").max(max, `At most ${max} characters`);
const optional = (max = 255) => z.string().trim().max(max, `At most ${max} characters`);
const phone = z.string().trim().refine(isNanpPhone, "Enter a 10-digit US or Canadian phone number");
const url = z
	.string()
	.trim()
	.max(500)
	.regex(/^https?:\/\/[^\s.]+\.[^\s]+$/i, "Enter a full web address (https://…)");
const email = z.string().trim().email("Enter an email address");

export const smsRegistrationSchema = z
	.object({
		legal_name: required(),
		dba: optional(),
		ein: z
			.string()
			.trim()
			.refine(
				(v) => v === "" || /^\d{2}-?\d{7}$/.test(v),
				"Enter the 9-digit EIN (12-3456789)"
			),
		entity_type: z.enum(SMS_ENTITY_TYPES, "Choose a business type"),
		vertical: z
			.string()
			.refine(
				(v) => SMS_VERTICALS.some((x) => x.value === v),
				"Choose an industry"
			),
		address: z
			.object({
				street: required(),
				street_secondary: optional(),
				city: required(100),
				region: z
					.string()
					.trim()
					.regex(/^[A-Za-z]{2}$/, "Choose a state or province"),
				postal_code: z.string().trim(),
				iso_country: z.enum(["US", "CA"]),
			})
			.superRefine((a, ctx) => {
				const ok =
					a.iso_country === "US"
						? /^\d{5}(-\d{4})?$/.test(a.postal_code)
						: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/.test(
								a.postal_code
							);
				if (!ok)
					ctx.addIssue({
						code: "custom",
						path: ["postal_code"],
						message:
							a.iso_country === "US"
								? "Enter a 5-digit ZIP code"
								: "Enter a postal code like A1A 1A1",
					});
			}),
		website: url,
		support_email: email,
		support_phone: phone,
		rep_name: required(),
		rep_title: required(100),
		rep_email: email,
		rep_phone: phone,
		sole_prop_mobile: z
			.string()
			.trim()
			.refine(
				(v) => v === "" || isNanpPhone(v),
				"Enter a 10-digit mobile number"
			),
		privacy_url: url,
		terms_url: url,
		area_code: z
			.string()
			.trim()
			.regex(/^[2-9]\d{2}$/, "Enter a 3-digit area code"),
	})
	.superRefine((f, ctx) => {
		if (!f.ein && !f.sole_prop_mobile)
			ctx.addIssue({
				code: "custom",
				path: ["ein"],
				message: "Enter your EIN, or a mobile number to register as a sole proprietor",
			});
	});

export type SmsRegistrationValues = z.input<typeof smsRegistrationSchema>;

/** Field path ("address.city") → first message. */
export function fieldErrors(values: SmsRegistrationValues): Record<string, string> {
	const r = smsRegistrationSchema.safeParse(values);
	if (r.success) return {};
	const out: Record<string, string> = {};
	for (const i of r.error.issues) {
		const key = i.path.join(".");
		out[key] ??= i.message;
	}
	return out;
}
