import { z } from "zod";

export const EmailTemplateCategory = z.enum([
	"followup",
	"reminder",
	"quote_chase",
	"invoice_chase",
	"request_ack",
	"custom",
]);

export type EmailTemplateCategoryValue = z.infer<typeof EmailTemplateCategory>;

export const upsertTemplateSchema = z.object({
	name: z.string().trim().min(1, "Name is required").max(120).optional(),
	subject: z.string().min(1, "Subject is required").max(300),
	// Generous ceiling — a full HTML email is a few KB; the cap only guards against
	// pathological payloads. Stored as TEXT in Postgres.
	html: z.string().min(1, "Template HTML is required").max(200_000),
	// Editable plain-text alternative. Blank/omitted → stored as null so the send
	// path auto-generates it from the HTML.
	text: z.string().max(100_000).nullable().optional(),
	// Text-message body, used by customer-message templates. Blank → null (built-in).
	sms_body: z.string().max(1600).nullable().optional(),
});

export type UpsertTemplateInput = z.infer<typeof upsertTemplateSchema>;
