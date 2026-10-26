import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	acknowledgeTaxReview,
	getAutoSwitchPreview,
	getTaxSettings,
	updateTaxSettings,
	type TaxReviewKind,
} from "../api/taxSettings";

export const TAX_SETTINGS_KEY = ["tax-settings"] as const;

export const useTaxSettings = (enabled = true) =>
	useQuery({ queryKey: TAX_SETTINGS_KEY, queryFn: getTaxSettings, enabled });

/** Only meaningful while the stored mode is manual; in auto the counts describe nothing. */
export const useAutoSwitchPreview = (enabled: boolean) =>
	useQuery({
		queryKey: [...TAX_SETTINGS_KEY, "preview"],
		queryFn: getAutoSwitchPreview,
		enabled,
		staleTime: 0,
	});

export const useUpdateTaxSettings = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: updateTaxSettings,
		onSuccess: (data) => {
			queryClient.setQueryData(TAX_SETTINGS_KEY, data);
			queryClient.invalidateQueries({ queryKey: ["org"] });
			// Cleared drafts recompute in the background; their cached totals are stale.
			for (const key of ["quotes", "jobs", "invoices", "jobVisits", "clients"])
				queryClient.invalidateQueries({ queryKey: [key] });
		},
	});
};

const REVIEW_KEY: Record<TaxReviewKind, string> = {
	quote: "quotes",
	job: "jobs",
	invoice: "invoices",
};

export const useAcknowledgeTaxReview = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ kind, id }: { kind: TaxReviewKind; id: string }) =>
			acknowledgeTaxReview(kind, id),
		onSuccess: (_d, { kind }) => {
			queryClient.invalidateQueries({ queryKey: [REVIEW_KEY[kind]] });
			queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
	});
};
