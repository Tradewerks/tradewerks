// Front-end feature flags.
//
// QUICKBOOKS_ENABLED — QuickBooks integration is temporarily disabled (not ready
// for production). While false, the Integrations settings card shows "Unavailable",
// the QuickBooks section renders a placeholder instead of the connect flow, and the
// QuickBooks dashboard widget is removed from the catalog. The backend mirrors this
// with quickbooksService.QB_ENABLED. Flip both to re-enable.
export const QUICKBOOKS_ENABLED = true;
