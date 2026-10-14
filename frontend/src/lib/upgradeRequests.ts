import { isAxiosError } from "axios";

export const requestSummary = (r: {
	requested_plan_label: string | null;
	requested_modules: { label: string }[];
}) =>
	[r.requested_plan_label, ...r.requested_modules.map((m) => m.label)]
		.filter(Boolean)
		.join(", ");

export const requestErrorMessage = (err: unknown, fallback: string) =>
	(isAxiosError(err) && err.response?.data?.error?.message) || fallback;
