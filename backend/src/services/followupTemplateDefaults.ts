// ============================================================================
// Built-in default email templates — one per followup category.
//
// These are the "starter" HTML templates. An org can override any of them via
// the in-app editor (persisted to the email_template table); a category with no
// saved row falls back to the default here. Templates are rendered with
// templateRenderer.ts, then sent via Postmark HtmlBody.
//
// Available variables (the send-time template model):
//   {{brand.name}} {{brand.logo_url}} {{brand.color}}
//   {{brand.address}} {{brand.phone}} {{brand.website}}
//   {{client_name}} {{unsubscribe_url}} (empty when the send has no contact)
// Sections like {{#brand.logo_url}}…{{/brand.logo_url}} conditionally render a
// block only when the value is present.
// ============================================================================

import type { EmailTemplateCategoryValue } from "../lib/validate/emailTemplates.js";

export interface DefaultTemplate {
	name: string;
	subject: string;
	html: string;
	text: string;
}

// Renders the shared email chrome (header band + card + footer) around a body.
// `body` is inner HTML for the message; `cta` is an optional call-to-action line.
function layout(preheader: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>{{brand.name}}</title>
</head>
<body style="margin:0; padding:0; background-color:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6; padding:24px 0;">
<tr>
<td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px; max-width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
<!-- Header -->
<tr>
<td style="background-color:{{brand.color}}; padding:28px 32px;" align="left">
{{#brand.logo_url}}
<img src="{{brand.logo_url}}" alt="{{brand.name}}" height="40" style="height:40px; max-height:40px; width:auto; display:block; border:0;" />
{{/brand.logo_url}}
{{^brand.logo_url}}
<span style="color:#ffffff; font-size:20px; font-weight:700; letter-spacing:0.2px;">{{brand.name}}</span>
{{/brand.logo_url}}
</td>
</tr>
<!-- Body -->
<tr>
<td style="padding:32px;">
${body}
</td>
</tr>
<!-- Footer -->
<tr>
<td style="background-color:#f9fafb; border-top:1px solid #e5e7eb; padding:20px 32px;">
<p style="margin:0; color:#6b7280; font-size:12px; line-height:1.6;">
<strong style="color:#374151;">{{brand.name}}</strong>{{#brand.address}} &middot; {{brand.address}}{{/brand.address}}
</p>
{{#brand.phone}}<p style="margin:4px 0 0; color:#6b7280; font-size:12px;">{{brand.phone}}</p>{{/brand.phone}}
{{#brand.website}}<p style="margin:4px 0 0; font-size:12px;"><a href="{{brand.website}}" style="color:{{brand.color}}; text-decoration:none;">{{brand.website}}</a></p>{{/brand.website}}
</td>
</tr>
</table>
<p style="margin:16px 0 0; color:#9ca3af; font-size:11px;">You received this email from {{brand.name}}.{{#unsubscribe_url}} <a href="{{unsubscribe_url}}" style="color:#9ca3af; text-decoration:underline;">Unsubscribe</a>{{/unsubscribe_url}}</p>
</td>
</tr>
</table>
</body>
</html>`;
}

const p = (text: string) =>
	`<p style="margin:0 0 16px; color:#374151; font-size:15px; line-height:1.65;">${text}</p>`;

const greeting = `<p style="margin:0 0 20px; color:#111827; font-size:16px;">Hi {{client_name}},</p>`;

const signoff = `<p style="margin:24px 0 0; color:#374151; font-size:15px; line-height:1.65;">Thanks,<br /><strong>The {{brand.name}} team</strong></p>`;

// Plain-text counterpart of `layout` — the text/plain alternative. `body` is the
// message wording (blank line between paragraphs). Uses the same variables so it
// stays in sync with the HTML when branding changes.
function textLayout(body: string): string {
	return `Hi {{client_name}},

${body}

Thanks,
The {{brand.name}} team

{{brand.name}}{{#brand.address}} · {{brand.address}}{{/brand.address}}{{#brand.phone}}
{{brand.phone}}{{/brand.phone}}{{#brand.website}}
{{brand.website}}{{/brand.website}}{{#unsubscribe_url}}

Unsubscribe: {{unsubscribe_url}}{{/unsubscribe_url}}`;
}

// Followup categories only; the lifecycle categories are customer messages.
export const DEFAULT_TEMPLATES: Record<EmailTemplateCategoryValue, DefaultTemplate> = {
	followup: {
		name: "General follow-up",
		subject: "Following up, {{client_name}}",
		html: layout(
			"Just checking in — we'd love to hear from you.",
			`${greeting}
${p("We wanted to follow up and make sure everything is on track. If there's anything at all we can help you with,{{#brand.reply_to}} just reply to this email{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}} just call us at {{brand.phone}}{{/brand.phone}}{{^brand.phone}} just let us know{{/brand.phone}}{{/brand.reply_to}} — we're happy to help.")}
${p("If now isn't the right time, no problem at all. We'll be here whenever you're ready.")}
${signoff}`,
		),
		text: textLayout(
			`We wanted to follow up and make sure everything is on track. If there's anything at all we can help you with,{{#brand.reply_to}} just reply to this email{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}} just call us at {{brand.phone}}{{/brand.phone}}{{^brand.phone}} just let us know{{/brand.phone}}{{/brand.reply_to}} — we're happy to help.

If now isn't the right time, no problem at all. We'll be here whenever you're ready.`,
		),
	},
	reminder: {
		name: "Appointment reminder",
		subject: "{{#visit.date}}Reminder: your visit on {{visit.date}}{{/visit.date}}{{^visit.date}}Reminder from {{brand.name}}{{/visit.date}}",
		html: layout(
			"A friendly reminder about your upcoming appointment.",
			`${greeting}
${p("This is a friendly reminder about your upcoming appointment{{#visit.date}} on {{visit.date}}, arriving {{visit.window}}{{#visit.address}} at {{visit.address}}{{/visit.address}}.{{#visit.tech_names}} {{visit.tech_names}} will be taking care of you.{{/visit.tech_names}}{{/visit.date}}{{^visit.date}} with our team.{{/visit.date}} We're looking forward to seeing you.")}
${p("If you need to reschedule or have any questions before then, {{#brand.reply_to}}simply reply to this email.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}give us a call at {{brand.phone}}.{{/brand.phone}}{{^brand.phone}}please contact us.{{/brand.phone}}{{/brand.reply_to}}")}
${signoff}`,
		),
		text: textLayout(
			`This is a friendly reminder about your upcoming appointment{{#visit.date}} on {{visit.date}}, arriving {{visit.window}}{{#visit.address}} at {{visit.address}}{{/visit.address}}.{{#visit.tech_names}} {{visit.tech_names}} will be taking care of you.{{/visit.tech_names}}{{/visit.date}}{{^visit.date}} with our team.{{/visit.date}} We're looking forward to seeing you.

If you need to reschedule or have any questions before then, {{#brand.reply_to}}simply reply to this email.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}give us a call at {{brand.phone}}.{{/brand.phone}}{{^brand.phone}}please contact us.{{/brand.phone}}{{/brand.reply_to}}`,
		),
	},
	quote_chase: {
		name: "Quote follow-up",
		subject: "Your quote from {{brand.name}}",
		html: layout(
			"Your quote is ready whenever you are.",
			`${greeting}
${p("We recently sent over a quote and wanted to check in to see if you had any questions. We'd be glad to walk you through the details or make any adjustments.")}
${p("Whenever you're ready to move forward, {{#brand.reply_to}}just reply to this email and we'll take care of the rest.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}just call us at {{brand.phone}} and we'll take care of the rest.{{/brand.phone}}{{^brand.phone}}just let us know and we'll take care of the rest.{{/brand.phone}}{{/brand.reply_to}}")}
${signoff}`,
		),
		text: textLayout(
			`We recently sent over a quote and wanted to check in to see if you had any questions. We'd be glad to walk you through the details or make any adjustments.

Whenever you're ready to move forward, {{#brand.reply_to}}just reply to this email and we'll take care of the rest.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}just call us at {{brand.phone}} and we'll take care of the rest.{{/brand.phone}}{{^brand.phone}}just let us know and we'll take care of the rest.{{/brand.phone}}{{/brand.reply_to}}`,
		),
	},
	invoice_chase: {
		name: "Invoice reminder",
		subject: "A quick reminder about your invoice",
		html: layout(
			"A gentle reminder about your outstanding invoice.",
			`${greeting}
${p("This is a gentle reminder that you have an invoice with an outstanding balance. When you have a moment, we'd appreciate you settling it at your convenience.")}
${p("If you've already sent payment, please disregard this message. If you have any questions about the invoice, {{#brand.reply_to}}reply to this email and we'll be happy to help.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}reach us at {{brand.phone}} and we'll be happy to help.{{/brand.phone}}{{^brand.phone}}contact us and we'll be happy to help.{{/brand.phone}}{{/brand.reply_to}}")}
${signoff}`,
		),
		text: textLayout(
			`This is a gentle reminder that you have an invoice with an outstanding balance. When you have a moment, we'd appreciate you settling it at your convenience.

If you've already sent payment, please disregard this message. If you have any questions about the invoice, {{#brand.reply_to}}reply to this email and we'll be happy to help.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}reach us at {{brand.phone}} and we'll be happy to help.{{/brand.phone}}{{^brand.phone}}contact us and we'll be happy to help.{{/brand.phone}}{{/brand.reply_to}}`,
		),
	},
	request_ack: {
		name: "Request received",
		subject: "We received your request",
		html: layout(
			"Thanks for reaching out — we've got your request.",
			`${greeting}
${p("Thank you for reaching out! This is a quick note to let you know we've received your request and our team is reviewing it now.")}
${p("We'll be in touch shortly with next steps. In the meantime, if anything changes or you'd like to add details, {{#brand.reply_to}}just reply to this email.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}call us at {{brand.phone}}.{{/brand.phone}}{{^brand.phone}}contact us.{{/brand.phone}}{{/brand.reply_to}}")}
${signoff}`,
		),
		text: textLayout(
			`Thank you for reaching out! This is a quick note to let you know we've received your request and our team is reviewing it now.

We'll be in touch shortly with next steps. In the meantime, if anything changes or you'd like to add details, {{#brand.reply_to}}just reply to this email.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}}call us at {{brand.phone}}.{{/brand.phone}}{{^brand.phone}}contact us.{{/brand.phone}}{{/brand.reply_to}}`,
		),
	},
	custom: {
		name: "Custom message",
		subject: "A message from {{brand.name}}",
		html: layout(
			"A message from {{brand.name}}.",
			`${greeting}
${p("Add your message here. You can edit this template freely — use the variables panel to drop in details like the client's name or your company contact information.")}
${signoff}`,
		),
		text: textLayout(
			`Add your message here. You can edit this template freely — use the variables panel to drop in details like the client's name or your company contact information.`,
		),
	},
};
