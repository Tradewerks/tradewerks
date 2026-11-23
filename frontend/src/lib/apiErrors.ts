import { isAxiosError } from "axios";

/** A save refused because the record moved on since it was loaded (HTTP 409 CONFLICT). */
export class ConflictError extends Error {
	readonly status = 409;
	readonly currentUpdatedAt: string;

	constructor(message: string, currentUpdatedAt: string) {
		super(message);
		this.name = "ConflictError";
		this.currentUpdatedAt = currentUpdatedAt;
	}
}

/** The version token a visit PUT carries as expected_updated_at. */
export const visitVersion = (visit: { updated_at?: Date | string } | undefined): string | undefined => {
	if (!visit?.updated_at) return undefined;
	return typeof visit.updated_at === "string" ? visit.updated_at : visit.updated_at.toISOString();
};

export const isConflict = (err: unknown): err is ConflictError => err instanceof ConflictError;

/** The ConflictError a 409 CONFLICT response carries, or null for any other failure. */
export const conflictFromResponse = (err: unknown): ConflictError | null => {
	if (!isAxiosError(err) || err.response?.status !== 409) return null;
	const body = err.response.data as
		| { data?: { current_updated_at?: string | null }; error?: { code?: string; message?: string } }
		| undefined;
	if (body?.error?.code !== "CONFLICT") return null;
	return new ConflictError(
		body.error.message ?? "This record was changed by someone else.",
		body.data?.current_updated_at ?? "",
	);
};
