-- Dispute authority split out of the blanket edit_quotes / edit_invoices grants.
--
-- Every statement is guarded by NOT (permissions @> ...), so re-running this
-- migration is a no-op. Nothing is ever removed, and technician-tier roles are
-- untouched. Users whose role is "admin" bypass the permission array entirely
-- (resolvePerms in requirePermissions.ts), so they need no backfill.

-- Recording that a client disagrees is not a document edit, but anyone who
-- could already act on the document must keep being able to log it.
UPDATE "organization_role"
SET "permissions" = "permissions" || ARRAY['open_disputes']
WHERE "base_tier" = 'dispatcher'
  AND "permissions" && ARRAY['edit_quotes', 'edit_invoices']
  AND NOT ("permissions" @> ARRAY['open_disputes']);

-- Resolving a dispute and conceding money are new abilities, so granting them
-- narrowly takes nothing from anyone: they go to whoever already administers
-- the organization, and widening from there is a deliberate act in the roles
-- editor.
UPDATE "organization_role"
SET "permissions" = "permissions" || ARRAY['resolve_disputes']
WHERE "base_tier" = 'dispatcher'
  AND "permissions" && ARRAY['manage_roles', 'manage_organization']
  AND NOT ("permissions" @> ARRAY['resolve_disputes']);

UPDATE "organization_role"
SET "permissions" = "permissions" || ARRAY['concede_disputes']
WHERE "base_tier" = 'dispatcher'
  AND "permissions" && ARRAY['manage_roles', 'manage_organization']
  AND NOT ("permissions" @> ARRAY['concede_disputes']);

-- refund_invoices is different: it re-gates two acts that already existed
-- behind edit_invoices (voiding an invoice, deleting a payment). Granting it
-- only to administrators would silently take both away from every billing
-- role on deploy day, so it also goes to every role holding edit_invoices.
-- Narrowing it is then the owner's visible choice in the roles editor. The new
-- org default dispatcher template follows the same rule, pinned by
-- defaultRolePermissions.test.ts.
UPDATE "organization_role"
SET "permissions" = "permissions" || ARRAY['refund_invoices']
WHERE "base_tier" = 'dispatcher'
  AND "permissions" && ARRAY['edit_invoices', 'manage_roles', 'manage_organization']
  AND NOT ("permissions" @> ARRAY['refund_invoices']);

-- resolve_own_disputes is deliberately granted to nobody. It exists for
-- owner-operator orgs, where the person who logged the dispute is the only
-- person who could ever close it, and that is a decision the owner makes.
