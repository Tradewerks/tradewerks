-- Emailing a document to the client split out of the blanket edit_* grants.
--
-- Every statement is guarded by NOT (permissions @> ...), so re-running this
-- migration is a no-op. Nothing is ever removed, and technician-tier roles are
-- untouched. Users whose role is "admin" bypass the permission array entirely
-- (resolvePerms in requirePermissions.ts), so they need no backfill.

-- send_quotes re-gates an act that already lived behind edit_quotes. Granting
-- it narrowly would silently take sending away from every role that has it
-- today, so it goes to every role holding edit_quotes; narrowing from there is
-- the owner's visible choice in the roles editor. The new org default
-- dispatcher template follows the same rule, pinned by
-- defaultRolePermissions.test.ts.
UPDATE "organization_role"
SET "permissions" = "permissions" || ARRAY['send_quotes']
WHERE "base_tier" = 'dispatcher'
  AND "permissions" && ARRAY['edit_quotes']
  AND NOT ("permissions" @> ARRAY['send_quotes']);

UPDATE "organization_role"
SET "permissions" = "permissions" || ARRAY['send_invoices']
WHERE "base_tier" = 'dispatcher'
  AND "permissions" && ARRAY['edit_invoices']
  AND NOT ("permissions" @> ARRAY['send_invoices']);
