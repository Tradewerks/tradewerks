-- organization.measurement_system stays TEXT (see schema.prisma); this CHECK
-- only stops a raw write from storing a value the API's Zod enum rejects.
-- Normalize first so the constraint can't fail on a stray existing value.
UPDATE "organization"
  SET "measurement_system" = 'imperial'
  WHERE "measurement_system" NOT IN ('imperial', 'metric');

ALTER TABLE "organization" ADD CONSTRAINT "organization_measurement_system_chk"
  CHECK ("measurement_system" IN ('imperial', 'metric'));
