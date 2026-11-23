export type CustomerEvent =
	| "visit_confirmed"
	| "visit_reminder"
	| "visit_rescheduled"
	| "visit_cancelled"
	| "tech_on_the_way"
	| "tech_running_late"
	| "visit_completed"
	| "review_request";

export interface ReminderConfig {
	lead_hours: number[];
}

export interface LateConfig {
	threshold_minutes: number;
}

export interface CustomerEventSetting {
	event: CustomerEvent;
	label: string;
	description: string;
	email_enabled: boolean;
	sms_enabled: boolean;
	config: Partial<ReminderConfig> & Partial<LateConfig> & Record<string, unknown>;
	sms_available: boolean;
	/** Present on review_request only. */
	review_url?: string | null;
}

export interface UpdateCustomerEventSetting {
	email_enabled?: boolean;
	sms_enabled?: boolean;
	config?: Record<string, unknown>;
	review_url?: string | null;
}
