import {z} from "zod"

const maintenanceCategoryEnum = z.enum([
  "oil_change", "fluids", "tire", "brake", "inspection", "registration", "repair", "other",
]);

const maintenanceRecordFields = z.object({
  category: maintenanceCategoryEnum,
  performed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "performed_at must be YYYY-MM-DD"),
  odometer_mi: z.number().int().min(0).optional().nullable(),
  interval_miles: z.number().int().min(0).optional().nullable(),
  interval_months: z.number().int().min(0).optional().nullable(),
  cost: z.number().min(0).optional().nullable(),
  vendor_name: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  source_purchase_line_id: z.string().optional().nullable(),
  source_field_purchase_line_id: z.string().optional().nullable(),
});

export const createMaintenanceRecordSchema = maintenanceRecordFields.extend({
  reminder_ids: z.array(z.string().uuid()).optional(),
});

export const updateMaintenanceRecordSchema = maintenanceRecordFields.partial();

const intervalUnitEnum = z.enum(["days", "weeks", "months", "years"]);

const maintenanceReminderFields = z.object({
  category: maintenanceCategoryEnum,
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  interval_miles: z.number().int().min(0).optional().nullable(),
  interval_unit: intervalUnitEnum.optional().nullable(),
  interval_count: z.number().int().min(1).optional().nullable(),
  repeats: z.boolean().optional().default(true),
  due_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due_at must be YYYY-MM-DD").optional().nullable(),
  due_odometer_mi: z.number().int().min(0).optional().nullable(),
});

export const createMaintenanceReminderSchema = maintenanceReminderFields.refine(
  (data) => (data.interval_unit == null) === (data.interval_count == null),
  { message: "interval_unit and interval_count must be set together" },
).refine(
  (data) =>
    data.repeats
      ? data.interval_miles != null || (data.interval_unit != null && data.interval_count != null)
      : data.due_at != null || data.due_odometer_mi != null,
  {
    message:
      "repeating reminders need interval_miles or an interval_unit/interval_count pair; one-time reminders need due_at or due_odometer_mi",
  },
);

export const updateMaintenanceReminderSchema = maintenanceReminderFields.partial();