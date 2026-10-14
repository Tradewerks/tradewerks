-- Repeating reminders now anchor on baseline_* only (moved when a record covers them).
-- Backfill: copy each repeating reminder's current anchor (latest same-category record on/after baseline) into baseline_*.
UPDATE "vehicle_maintenance_reminder" AS r
SET "baseline_at" = latest."performed_at",
    "baseline_odometer_mi" = COALESCE(latest."odometer_mi", r."baseline_odometer_mi")
FROM (
    SELECT DISTINCT ON (rem."id") rem."id" AS reminder_id, rec."performed_at", rec."odometer_mi"
    FROM "vehicle_maintenance_reminder" rem
    JOIN "vehicle_maintenance_record" rec
      ON rec."vehicle_id" = rem."vehicle_id"
     AND rec."category" = rem."category"
     AND (rem."baseline_at" IS NULL OR rec."performed_at" >= date_trunc('day', rem."baseline_at"))
    WHERE rem."repeats"
    ORDER BY rem."id", rec."performed_at" DESC, rec."created_at" DESC
) AS latest
WHERE r."id" = latest.reminder_id;
