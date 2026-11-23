import type { CustomerEvent } from "./events.js";

export interface NotificationTemplate {
	subject: string;
	html: string;
	text: string;
	sms: string;
}

// Variables: {{brand.name}} {{brand.phone}} {{client_name}} {{unsubscribe_url}}
// and, for visit events, {{visit.date}} {{visit.window}} {{visit.address}}
// {{visit.job_title}} {{visit.name}} {{visit.description}} {{visit.tech_names}}
// {{visit.tech_first_name}} {{visit.eta}} {{tech.name}} {{tech.title}}
// {{tech.photo_url}} (email only) {{link.visit}}.
interface TemplateOptions {
	visitLink?: boolean;
	linkText?: string;
	/** HTML placed above the message line. */
	htmlLead?: string;
	/** The SMS line, when the email line is too long for a text. */
	smsLine?: string;
}

function template(
	subject: string,
	line: string,
	{
		visitLink = false,
		linkText = "View your appointment",
		htmlLead = "",
		smsLine = line,
	}: TemplateOptions = {},
): NotificationTemplate {
	const contact =
		"{{#brand.reply_to}} Questions? Just reply to this email.{{/brand.reply_to}}{{^brand.reply_to}}{{#brand.phone}} Questions? Call us at {{brand.phone}}.{{/brand.phone}}{{/brand.reply_to}}";
	const link = (s: string) =>
		visitLink ? `{{#link.visit}}${s}{{/link.visit}}` : "";
	return {
		subject,
		html: `<p>Hi {{client_name}},</p>
${htmlLead}<p>${line}${contact}</p>
${link(`<p><a href="{{link.visit}}">${linkText}</a></p>\n`)}<p>{{brand.name}}</p>
{{#unsubscribe_url}}<p style="font-size:12px;color:#6b7280;"><a href="{{unsubscribe_url}}">Unsubscribe</a></p>{{/unsubscribe_url}}`,
		text: `Hi {{client_name}},

${line}${contact}
${link(`\n${linkText}: {{link.visit}}\n`)}
{{brand.name}}
{{#unsubscribe_url}}
Unsubscribe: {{unsubscribe_url}}{{/unsubscribe_url}}`,
		// No STOP line: the SMS channel appends it to a contact's first text.
		sms: `{{brand.name}}: ${smsLine}${link(" Details: {{link.visit}}")}`,
	};
}

const TECH_PHOTO =
	'{{#tech.photo_url}}<p><img src="{{tech.photo_url}}" alt="{{tech.name}}" width="72" height="72" style="border-radius:36px;object-fit:cover;"></p>\n{{/tech.photo_url}}';
const DONE =
	"{{#visit.name}} Work done: {{visit.name}}.{{/visit.name}}{{#visit.description}} {{visit.description}}{{/visit.description}}";
const BY =
	"{{#visit.tech_first_name}} Your technician was {{visit.tech_first_name}}.{{/visit.tech_first_name}}";

export const DEFAULT_NOTIFICATION_TEMPLATES: Record<
	CustomerEvent,
	NotificationTemplate
> = {
	visit_confirmed: template(
		"Your appointment with {{brand.name}} is confirmed",
		"Your appointment is confirmed for {{visit.date}}, arriving {{visit.window}}.",
		{ visitLink: true },
	),
	visit_reminder: template(
		"Reminder: your appointment with {{brand.name}}",
		"This is a reminder of your appointment on {{visit.date}}, arriving {{visit.window}}.",
		{ visitLink: true },
	),
	visit_rescheduled: template(
		"Your appointment with {{brand.name}} has moved",
		"Your appointment has moved to {{visit.date}}, arriving {{visit.window}}.",
		{ visitLink: true },
	),
	visit_cancelled: template(
		"Your appointment with {{brand.name}} is cancelled",
		"Your appointment on {{visit.date}} has been cancelled.",
	),
	tech_on_the_way: template(
		"{{brand.name}} is on the way",
		"{{#visit.tech_first_name}}{{visit.tech_first_name}}{{/visit.tech_first_name}}{{^visit.tech_first_name}}Your technician{{/visit.tech_first_name}} is on the way for your appointment today.{{#visit.eta}} Estimated arrival: {{visit.eta}}.{{/visit.eta}}",
		{ visitLink: true, htmlLead: TECH_PHOTO },
	),
	tech_running_late: template(
		"{{brand.name}} is running late",
		"We're running late for your appointment today.{{#visit.eta}} Your technician now expects to arrive around {{visit.eta}}.{{/visit.eta}} Thanks for your patience.",
		{ visitLink: true },
	),
	visit_completed: template(
		"Your visit with {{brand.name}} is complete",
		`Your visit on {{visit.date}} is complete.${DONE}${BY} Thank you for choosing us.`,
		{
			visitLink: true,
			linkText: "View your visit summary",
			smsLine: `Your visit on {{visit.date}} is complete.{{#visit.name}} Work done: {{visit.name}}.{{/visit.name}}${BY} Thank you!`,
		},
	),
	review_request: template(
		"How did {{brand.name}} do?",
		"Thank you for choosing us. We'd appreciate hearing how we did.{{#brand.review_url}} Leave a review: {{brand.review_url}}{{/brand.review_url}}",
	),
};
