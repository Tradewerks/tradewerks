import axios from "axios";
import type { ApiResponse } from "../types/api";

// Customer pages have no session: a bare client keeps the auth interceptors (and
// their token refresh and redirect-to-login handling) out of these calls.
const publicApi = axios.create({ baseURL: import.meta.env.VITE_BACKEND_URL });

export interface PublicOrg {
	name: string;
	logo_url: string | null;
	color: string;
	phone: string | null;
	email: string | null;
}

export type ConsentState = "subscribed" | "unsubscribed";

export interface UnsubscribeLinkData {
	purpose: "unsubscribe";
	org: PublicOrg;
	contact_email_masked: string | null;
	email: ConsentState;
	sms: ConsentState;
}

export interface PublicLineItem {
	name: string;
	description: string | null;
	quantity: number;
	unit_price: number;
	total: number;
}

export interface PublicQuote {
	number: string;
	title: string;
	status: string;
	line_items: PublicLineItem[];
	subtotal: number;
	discount_amount: number;
	tax_amount: number;
	total: number;
	valid_until: string | null;
	can_respond: boolean;
	superseded: boolean;
	approved_at: string | null;
	approved_by_name: string | null;
}

export interface QuoteLinkData extends PublicQuote {
	purpose: "quote";
	org: PublicOrg;
}

export interface InvoiceLinkData {
	purpose: "invoice";
	org: PublicOrg;
	number: string;
	status_label: string;
	issue_date: string | null;
	due_date: string | null;
	line_items: PublicLineItem[];
	total: number;
	amount_paid: number;
	balance_due: number;
}

export interface VisitLinkData {
	purpose: "visit";
	org: PublicOrg;
	date: string;
	window: string;
	address: string;
	status_label: string;
	phase: "scheduled" | "driving" | "arrived" | "done" | "other";
	tech_first_names: string[];
	eta: string | null;
	/** Signed; expires an hour after the page loaded. */
	tech_photo_url: string | null;
	/** What was done, once the visit is complete. */
	summary: { name: string | null; description: string | null } | null;
	photos: VisitPhoto[];
}

export interface VisitPhoto {
	url: string;
	label: string;
	name: string | null;
}

export type PublicLinkData = UnsubscribeLinkData | QuoteLinkData | InvoiceLinkData | VisitLinkData;

function unwrap<T>(body: ApiResponse<T>): T {
	if (!body.success || body.data == null) {
		throw new Error(body.error?.message || "Something went wrong");
	}
	return body.data;
}

export const getPublicLink = async (token: string): Promise<PublicLinkData> => {
	const res = await publicApi.post<ApiResponse<PublicLinkData>>("/public/link", { token });
	return unwrap(res.data);
};

// The first resolve leaves the document's status alone so email scanners that
// prefetch links don't mark it Viewed; the page sends this once it is on screen.
export const markPublicLinkViewed = async (token: string): Promise<void> => {
	await publicApi.post("/public/link", { token, mark_viewed: true });
};

export const respondToPublicQuote = async (
	token: string,
	action: "approve" | "decline",
	name: string,
	reason?: string
): Promise<PublicQuote> => {
	const res = await publicApi.post<ApiResponse<PublicQuote>>("/public/quote/respond", {
		token,
		action,
		name,
		...(reason ? { reason } : {}),
	});
	return unwrap(res.data);
};

export const getPublicDocumentPdf = async (token: string): Promise<Blob> => {
	const res = await publicApi.post(
		"/public/document/pdf",
		{ token },
		{ responseType: "blob" }
	);
	return res.data as Blob;
};

export const setPublicConsent = async (
	token: string,
	channel: "email" | "sms",
	status: ConsentState
): Promise<{ email: ConsentState; sms: ConsentState }> => {
	const res = await publicApi.post<ApiResponse<{ email: ConsentState; sms: ConsentState }>>(
		"/public/unsubscribe",
		{ token, channel, status }
	);
	return unwrap(res.data);
};
