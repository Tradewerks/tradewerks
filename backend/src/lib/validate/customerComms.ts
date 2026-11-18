import { z } from "zod";
import {
	CUSTOMER_EVENTS,
	type CustomerEvent,
} from "../../services/customerComms/events.js";
import { reviewUrlSchema } from "./organizations.js";

export const CustomerEventParam = z.enum(CUSTOMER_EVENTS);

export const reminderConfigSchema = z
	.object({
		lead_hours: z
			.array(z.number().int().min(1).max(168))
			.min(1, "Add at least one reminder")
			.max(3, "At most three reminders")
			.refine((h) => new Set(h).size === h.length, "Reminder times must differ"),
	})
	.strict();

export const DEFAULT_REMINDER_CONFIG = { lead_hours: [24] };

export const reviewConfigSchema = z
	.object({
		delay_hours: z
			.number()
			.int("Use whole hours")
			.min(1, "Wait at least 1 hour")
			.max(72, "Wait at most 72 hours"),
	})
	.strict();

export const DEFAULT_REVIEW_CONFIG = { delay_hours: 2 };

export const MIN_LATE_THRESHOLD_MINUTES = 10;

export const lateConfigSchema = z
	.object({
		threshold_minutes: z
			.number()
			.int("Use whole minutes")
			.min(MIN_LATE_THRESHOLD_MINUTES, "Use at least 10 minutes")
			.max(120, "Use at most 120 minutes"),
	})
	.strict();

export const DEFAULT_LATE_CONFIG = { threshold_minutes: 20 };

const emptyConfigSchema = z.object({}).strict();

export const updateSettingSchema = z
	.object({
		email_enabled: z.boolean().optional(),
		sms_enabled: z.boolean().optional(),
		config: z.record(z.string(), z.unknown()).optional(),
		// Stored on the organization; accepted here so the review request can
		// be set up by whoever manages customer messages.
		review_url: reviewUrlSchema.optional(),
	})
	.strict();

export type UpdateSettingInput = z.infer<typeof updateSettingSchema>;

/** Validates `config` against the shape its event accepts. */
export function parseEventConfig(event: CustomerEvent, config: unknown) {
	const schema =
		event === "visit_reminder"
			? reminderConfigSchema
			: event === "review_request"
				? reviewConfigSchema
				: event === "tech_running_late"
					? lateConfigSchema
					: emptyConfigSchema;
	return schema.safeParse(config);
}

export const messagesQuerySchema = z.object({
	entity_type: z.string().min(1).max(40).optional(),
	entity_id: z.string().min(1).max(100).optional(),
	client_id: z.string().min(1).max(100).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
