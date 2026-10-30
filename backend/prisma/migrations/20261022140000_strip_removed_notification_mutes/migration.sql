-- The preference validator now rejects the removed taxability notification types, and the
-- preferences card resends the whole stored array, so stale mutes would 400 every save.

UPDATE "dispatcher"
SET "muted_notification_types" = array_remove(
	array_remove("muted_notification_types", 'taxability_review_requested'),
	'taxability_rule_expiring'
)
WHERE "muted_notification_types" && ARRAY['taxability_review_requested', 'taxability_rule_expiring'];
