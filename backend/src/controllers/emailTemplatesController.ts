import { getScopedDb } from "../lib/context.js";
import type {
	EmailTemplateCategoryValue,
	UpsertTemplateInput,
} from "../lib/validate/emailTemplates.js";
import { getOrgBrand } from "../services/emailBranding.js";
import {
	listEffectiveTemplates,
	type EffectiveTemplate,
} from "../services/followupTemplates.js";
import { saveTemplate, deleteTemplate } from "../services/emailTemplateStore.js";
import { DEFAULT_TEMPLATES } from "../services/followupTemplateDefaults.js";

const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });

/** All templates for the org (saved overrides merged over built-in defaults). */
export async function listTemplates(orgId: string): Promise<EffectiveTemplate[]> {
	return listEffectiveTemplates(orgId);
}

/** A single category's effective template. */
export async function getTemplate(
	orgId: string,
	category: EmailTemplateCategoryValue,
): Promise<EffectiveTemplate> {
	const all = await listEffectiveTemplates(orgId);
	const found = all.find((t) => t.category === category);
	if (!found) throw notFound("Template not found");
	return found;
}

/** Create or update an org's template for a category. */
export async function upsertTemplate(
	orgId: string,
	category: EmailTemplateCategoryValue,
	input: UpsertTemplateInput,
	dispatcherId: string | null,
): Promise<EffectiveTemplate> {
	return saveTemplate(orgId, category, input, dispatcherId, DEFAULT_TEMPLATES[category].name);
}

/** Discard an org's override, reverting the category to its built-in default. */
export async function resetTemplate(
	orgId: string,
	category: EmailTemplateCategoryValue,
): Promise<EffectiveTemplate> {
	const d = DEFAULT_TEMPLATES[category];
	return deleteTemplate(orgId, category, { ...d, sms_body: null });
}

/**
 * Prefill values for the editor's live preview: the org's real branding (logo
 * signed for email use) plus sample content variables. Mirrors the shape of the
 * send-time template model so the preview matches what a client will receive.
 */
export async function getPreviewContext(orgId: string): Promise<{
	brand: Awaited<ReturnType<typeof getOrgBrand>>;
	samples: { client_name: string; anchor_type: string | null };
}> {
	const sdb = getScopedDb(orgId);
	const [brand, client] = await Promise.all([
		getOrgBrand(orgId),
		sdb.client.findFirst({ select: { name: true } }),
	]);
	return {
		brand,
		samples: {
			client_name: client?.name ?? "Alex Johnson",
			anchor_type: null,
		},
	};
}
