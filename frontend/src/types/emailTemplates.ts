import type { EmailTemplateCategory } from "./followups";
import type { CustomerEvent } from "./customerComms";

// One org-editable email template, resolved server-side (saved override merged
// over the built-in default). `is_customized` distinguishes the two.
export interface EmailTemplate {
	category: EmailTemplateCategory | CustomerEvent;
	name: string;
	subject: string;
	html: string;
	// Editable plain-text alternative. null = auto-generated from the HTML at send time.
	text: string | null;
	// Text-message body; only customer-message templates carry one.
	sms_body?: string | null;
	is_customized: boolean;
	updated_at: string | null;
}

export interface UpsertTemplateInput {
	name?: string;
	subject: string;
	html: string;
	text?: string | null;
	sms_body?: string | null;
}

// The org branding fragment that becomes {{brand.*}} at send/preview time.
export interface TemplateBrand {
	name: string;
	logo_url: string | null;
	color: string;
	address: string | null;
	phone: string | null;
	website: string | null;
	reply_to?: string | null;
}

// Prefill values for the live preview — mirrors the send-time template model.
export interface TemplatePreviewContext {
	brand: TemplateBrand;
	samples: {
		client_name: string;
		anchor_type: string | null;
	};
}
