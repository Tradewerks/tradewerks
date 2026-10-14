export interface ApiResponse<T> {
	success: boolean;
	data: T | null;
	error: {
		code: string;
		message: string;
		// Machine-readable payload for errors a caller can act on rather than
		// just display — e.g. a 409 carries the row that already exists.
		details?: unknown;
	} | null;
	meta?: {
		timestamp: string;
		count?: number;
		// Server-side row cap was hit: `data` is a prefix of the real result set,
		// not the whole thing. Mirrors ResponseMeta.hasMore on the backend.
		hasMore?: boolean;
		// Rows matching the query, ignoring the page cap — what "showing 50 of 412"
		// needs and `count` cannot answer.
		total?: number;
		page?: number;
		pageSize?: number;
	};
}
