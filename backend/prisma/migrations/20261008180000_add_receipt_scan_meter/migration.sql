-- Tier versions written before this meter existed read a missing key as unlimited.
-- Backfill so no tier scans without a cap by accident; Legacy stays unlimited like its other meters.
UPDATE "plan_version"
SET "limits" = "limits" || jsonb_build_object(
    'receipt_scans_month',
    CASE "plan_key"
        WHEN 'legacy' THEN NULL
        WHEN 'pro' THEN 300
        WHEN 'enterprise' THEN 3000
        ELSE 0
    END
)
WHERE NOT ("limits" ? 'receipt_scans_month');
