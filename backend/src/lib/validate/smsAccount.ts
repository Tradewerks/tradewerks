import { z } from "zod";
import { toE164 } from "../../services/sms/phone.js";

// Twilio Trust Hub `business_type` values.
export const SMS_ENTITY_TYPES = [
	"Sole Proprietorship",
	"Partnership",
	"Limited Liability Corporation",
	"Co-operative",
	"Non-profit Corporation",
	"Corporation",
] as const;

// Twilio `business_industry` / TCR vertical values that fit a field-service org.
export const SMS_VERTICALS = [
	"CONSTRUCTION",
	"PROFESSIONAL_SERVICES",
	"ENERGY",
	"ENGINEERING",
	"REAL_ESTATE",
	"RETAIL",
	"AUTOMOTIVE",
	"MANUFACTURING",
] as const;

const text = (max = 255) =>
	z.string().trim().min(1, "Required").max(max, `At most ${max} characters`);

const optionalText = (max = 255) =>
	z
		.string()
		.trim()
		.max(max, `At most ${max} characters`)
		.optional()
		.transform((v) => v || undefined);

const phone = z
	.string()
	.trim()
	.transform((v, ctx) => {
		const e164 = toE164(v, "US");
		if (!e164) {
			ctx.addIssue({
				code: "custom",
				message: "Enter a 10-digit US or Canadian phone number",
			});
			return z.NEVER;
		}
		return e164;
	});

const url = z
	.string()
	.trim()
	.max(500)
	.regex(
		/^https?:\/\/[^\s.]+\.[^\s]+$/i,
		"Enter a full web address (https://…)",
	);

const POSTAL = {
	US: /^\d{5}(-\d{4})?$/,
	CA: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/,
};

const addressSchema = z
	.object({
		street: text(),
		street_secondary: optionalText(),
		city: text(100),
		region: z
			.string()
			.trim()
			.regex(/^[A-Za-z]{2}$/, "Use the two-letter state or province")
			.transform((v) => v.toUpperCase()),
		postal_code: z.string().trim(),
		iso_country: z.enum(["US", "CA"]),
	})
	.strict()
	.superRefine((a, ctx) => {
		if (!POSTAL[a.iso_country].test(a.postal_code))
			ctx.addIssue({
				code: "custom",
				path: ["postal_code"],
				message:
					a.iso_country === "US"
						? "Enter a 5-digit ZIP code"
						: "Enter a postal code like A1A 1A1",
			});
	});

export const smsRegistrationSchema = z
	.object({
		legal_name: text(),
		dba: optionalText(),
		ein: z
			.string()
			.trim()
			.optional()
			.transform((v) => v || undefined)
			.refine(
				(v) => v === undefined || /^\d{2}-?\d{7}$/.test(v),
				"Enter the 9-digit EIN (12-3456789)",
			),
		entity_type: z.enum(SMS_ENTITY_TYPES),
		vertical: z.enum(SMS_VERTICALS),
		address: addressSchema,
		website: url,
		support_email: z.string().trim().email("Enter an email address"),
		support_phone: phone,
		rep_name: text(),
		rep_title: text(100),
		rep_email: z.string().trim().email("Enter an email address"),
		rep_phone: phone,
		sole_prop_mobile: z
			.string()
			.trim()
			.optional()
			.transform((v) => v || undefined)
			.pipe(phone.optional()),
		privacy_url: url,
		terms_url: url,
		area_code: z
			.string()
			.trim()
			.regex(/^[2-9]\d{2}$/, "Enter a 3-digit area code"),
	})
	.strict()
	.superRefine((f, ctx) => {
		if (!f.ein && !f.sole_prop_mobile)
			ctx.addIssue({
				code: "custom",
				path: ["ein"],
				message:
					"Enter your EIN, or a mobile number to register as a sole proprietor",
			});
	});

/** A saved draft: any subset of the form, checked for size only. */
export const smsRegistrationDraftSchema = z
	.object({
		legal_name: z.string().max(255),
		dba: z.string().max(255),
		ein: z.string().max(20),
		entity_type: z.string().max(100),
		vertical: z.string().max(100),
		address: z
			.object({
				street: z.string().max(255),
				street_secondary: z.string().max(255),
				city: z.string().max(100),
				region: z.string().max(10),
				postal_code: z.string().max(20),
				iso_country: z.string().max(2),
			})
			.partial()
			.strict(),
		website: z.string().max(500),
		support_email: z.string().max(255),
		support_phone: z.string().max(40),
		rep_name: z.string().max(255),
		rep_title: z.string().max(100),
		rep_email: z.string().max(255),
		rep_phone: z.string().max(40),
		sole_prop_mobile: z.string().max(40),
		privacy_url: z.string().max(500),
		terms_url: z.string().max(500),
		area_code: z.string().max(10),
	})
	.partial()
	.strict();

export type SmsRegistrationInput = z.infer<typeof smsRegistrationSchema>;
export type SmsRegistrationDraft = z.infer<typeof smsRegistrationDraftSchema>;
