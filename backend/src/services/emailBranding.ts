import { z } from "zod";
import { db } from "../db.js";
import { signImageUrl } from "./wasabiService.js";

export interface OrgBrand {
	name: string;
	logo_url: string | null;
	color: string;
	address: string | null;
	phone: string | null;
	website: string | null;
	reply_to: string | null;
	review_url: string | null;
}

const DEFAULT_BRAND_COLOR = "#1e3a5f";

// Logo links embedded in emails must outlive the send: a followup can be sent
// hours/days after enrollment and opened later still. Sign for the AWS SigV4
// maximum (7 days) rather than the default 1-hour TTL so the logo doesn't 403
// in the recipient's inbox. (A logo opened >7 days after send won't render —
// acceptable trade-off vs. a stable public proxy endpoint.)
const EMAIL_LOGO_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Load an organization's branding, with the logo URL signed (long-lived) for external email use. */
export async function getOrgBrand(orgId: string): Promise<OrgBrand> {
	const org = await db.organization.findUnique({
		where: { id: orgId },
		select: {
			name: true,
			logo_url: true,
			brand_color: true,
			address: true,
			phone: true,
			website: true,
			email: true,
			review_url: true,
		},
	});
	const replyTo = z.string().email().safeParse(org?.email);
	return {
		name: org?.name ?? "",
		logo_url: await signImageUrl(org?.logo_url ?? null, EMAIL_LOGO_TTL_SECONDS),
		// `||` (not `??`) so a blank "" saved from a form falls back to the default color.
		color: org?.brand_color || DEFAULT_BRAND_COLOR,
		address: org?.address ?? null,
		phone: org?.phone ?? null,
		website: org?.website ?? null,
		// The org email is free text; only a valid address may become Reply-To.
		reply_to: replyTo.success ? replyTo.data : null,
		review_url: org?.review_url ?? null,
	};
}

/** Template-model fragment merged into every followup email so Postmark templates render org branding. */
export async function getOrgBrandModel(orgId: string): Promise<{ brand: OrgBrand }> {
	return { brand: await getOrgBrand(orgId) };
}
