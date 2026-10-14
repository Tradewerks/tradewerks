-- Current mileage now reads vehicle.current_odometer_mi only; fill it from the latest record reading where it was never set.
UPDATE "vehicle" AS v
SET "current_odometer_mi" = latest."odometer_mi",
    "odometer_updated_at" = latest."performed_at"
FROM (
    SELECT DISTINCT ON ("vehicle_id") "vehicle_id", "odometer_mi", "performed_at"
    FROM "vehicle_maintenance_record"
    WHERE "odometer_mi" IS NOT NULL
    ORDER BY "vehicle_id", "performed_at" DESC, "created_at" DESC
) AS latest
WHERE v."id" = latest."vehicle_id" AND v."current_odometer_mi" IS NULL;
