export type QbFaultError = { code?: unknown; Detail?: unknown; Message?: unknown };

/** The Fault.Error list qbFetch folds into its error text: `QB POST /x → 400: {"Fault":...}`. */
export function parseQbFault(err: unknown): QbFaultError[] {
	const text = err instanceof Error ? err.message : "";
	const start = text.indexOf("{");
	if (start < 0) return [];
	try {
		const errors = JSON.parse(text.slice(start))?.Fault?.Error;
		return Array.isArray(errors) ? errors : [];
	} catch {
		return [];
	}
}
