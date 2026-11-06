import { useState } from "react";
import { isAxiosError } from "axios";
import type { QbTaxZero } from "../../types/tax";
import { isQbTaxZeroError } from "./taxReviewGate";

/** Holds the items QuickBooks charged no tax on after a 409 QB_TAX_ZERO refusal. */
export function useQbTaxZero() {
	const [qbZero, setQbZero] = useState<QbTaxZero | null>(null);

	/** True when the error was QB_TAX_ZERO; the panel carries the message, no banner needed. */
	const handleError = (err: unknown): boolean => {
		if (!isQbTaxZeroError(err)) return false;
		const details = isAxiosError(err)
			? (err.response?.data?.error?.details as QbTaxZero | undefined)
			: undefined;
		setQbZero(details ?? { items: [], line_ids: [] });
		return true;
	};

	return { qbZero, handleError, clear: () => setQbZero(null) };
}
