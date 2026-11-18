import { db } from "../db.js";
import type { email_template_category } from "../../generated/prisma/client.js";
import type { UpsertTemplateInput } from "../lib/validate/emailTemplates.js";
import type { EffectiveTemplate } from "./followupTemplates.js";

/** Built-in content a category falls back to when the org has no saved row. */
export interface TemplateDefaults {
	name: string;
	subject: string;
	html: string;
	text: string | null;
	sms_body: string | null;
}

export function defaultEffective(
	category: email_template_category,
	def: TemplateDefaults,
): EffectiveTemplate {
	return { category, ...def, is_customized: false, updated_at: null };
}

/** Saves the org's override and returns it as the effective template. */
export async function saveTemplate(
	orgId: string,
	category: email_template_category,
	input: UpsertTemplateInput,
	dispatcherId: string | null,
	defaultName: string,
): Promise<EffectiveTemplate> {
	const fields = {
		name: input.name?.trim() || defaultName,
		subject: input.subject,
		html: input.html,
		// Blank plain-text → null so the send path auto-generates it from the HTML.
		text: input.text && input.text.trim() ? input.text : null,
		sms_body:
			input.sms_body && input.sms_body.trim() ? input.sms_body : null,
		updated_by_dispatcher_id: dispatcherId,
	};
	const row = await db.email_template.upsert({
		where: {
			organization_id_category: { organization_id: orgId, category },
		},
		update: fields,
		create: { organization_id: orgId, category, ...fields },
	});
	return {
		category,
		name: row.name,
		subject: row.subject,
		html: row.html,
		text: row.text,
		sms_body: row.sms_body,
		is_customized: true,
		updated_at: row.updated_at,
	};
}

/** Discards the override; the category reverts to its built-in default. */
export async function deleteTemplate(
	orgId: string,
	category: email_template_category,
	def: TemplateDefaults,
): Promise<EffectiveTemplate> {
	await db.email_template.deleteMany({
		where: { organization_id: orgId, category },
	});
	return defaultEffective(category, def);
}

/** The org's saved template merged over the defaults. */
export async function loadTemplate(
	orgId: string,
	category: email_template_category,
	def: TemplateDefaults,
): Promise<EffectiveTemplate> {
	const row = await db.email_template.findUnique({
		where: {
			organization_id_category: { organization_id: orgId, category },
		},
	});
	if (!row) return defaultEffective(category, def);
	return {
		category: row.category,
		name: row.name,
		subject: row.subject,
		html: row.html,
		text: row.text,
		sms_body: row.sms_body ?? def.sms_body,
		is_customized: true,
		updated_at: row.updated_at,
	};
}
