export const CUSTOMER_EVENTS = [
	"visit_confirmed",
	"visit_reminder",
	"visit_rescheduled",
	"visit_cancelled",
	"tech_on_the_way",
	"tech_running_late",
	"visit_completed",
	"review_request",
] as const;
export type CustomerEvent = (typeof CUSTOMER_EVENTS)[number];

// Time-critical notices: holding them until morning would make them useless.
export const QUIET_HOURS_EXEMPT: CustomerEvent[] = [
	"visit_rescheduled",
	"visit_cancelled",
	"tech_on_the_way",
	"tech_running_late",
];

export function isCustomerEvent(value: string): value is CustomerEvent {
	return (CUSTOMER_EVENTS as readonly string[]).includes(value);
}

// Absence of a setting row means off, so existing orgs stay silent. A new org
// that has the module starts with the visit notices on; SMS is never defaulted.
export const NEW_ORG_EMAIL_DEFAULTS: { event: CustomerEvent; config: Record<string, unknown> }[] = [
	{ event: "visit_confirmed", config: {} },
	{ event: "visit_reminder", config: { lead_hours: [24] } },
	{ event: "visit_rescheduled", config: {} },
	{ event: "visit_cancelled", config: {} },
];
