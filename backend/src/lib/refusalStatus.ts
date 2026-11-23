// HTTP status for each `{ err, code }` refusal a controller returns. Input
// validation is 400 and never reaches this map.
export const REFUSAL_STATUS = {
	FORBIDDEN: 403,
	WRONG_STATE: 409,
	CONFLICT: 409,
	NOT_FOUND: 404,
} as const;

export type RefusalCode = keyof typeof REFUSAL_STATUS;
