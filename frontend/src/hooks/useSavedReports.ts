import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import * as savedReportsApi from "../api/savedReports";
import type {
	SavedReport,
	CreateSavedReportInput,
	UpdateSavedReportInput,
	ReportFavorite,
	CreateFavoriteInput,
} from "../types/reports";

const useQuery = moduleQuery("advanced_reporting");

export const useSavedReportsQuery = (): UseQueryResult<SavedReport[], Error> => {
	return useQuery({
		queryKey: ["reports", "saved"],
		queryFn: savedReportsApi.getSavedReports,
	});
};

export const useSavedReportQuery = (
	id: string | null,
): UseQueryResult<SavedReport, Error> => {
	return useQuery({
		queryKey: ["reports", "saved", id],
		queryFn: () => savedReportsApi.getSavedReport(id as string),
		enabled: !!id,
	});
};

export const useCreateSavedReportMutation = (): UseMutationResult<
	SavedReport,
	Error,
	CreateSavedReportInput
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: savedReportsApi.createSavedReport,
		onSuccess: (report) => {
			queryClient.invalidateQueries({ queryKey: ["reports", "saved"] });
			queryClient.setQueryData(["reports", "saved", report.id], report);
		},
	});
};

export const useUpdateSavedReportMutation = (): UseMutationResult<
	SavedReport,
	Error,
	{ id: string; data: UpdateSavedReportInput }
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }) => savedReportsApi.updateSavedReport(id, data),
		onSuccess: (report) => {
			queryClient.invalidateQueries({ queryKey: ["reports", "saved"] });
			queryClient.setQueryData(["reports", "saved", report.id], report);
		},
	});
};

export const useDeleteSavedReportMutation = (): UseMutationResult<
	{ id: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: savedReportsApi.deleteSavedReport,
		onSuccess: (_, deletedId) => {
			queryClient.invalidateQueries({ queryKey: ["reports", "saved"] });
			queryClient.removeQueries({ queryKey: ["reports", "saved", deletedId] });
			queryClient.invalidateQueries({ queryKey: ["reports", "favorites"] });
		},
	});
};

export const useReportFavoritesQuery = (): UseQueryResult<ReportFavorite[], Error> => {
	return useQuery({
		queryKey: ["reports", "favorites"],
		queryFn: savedReportsApi.getReportFavorites,
	});
};

export const useAddFavoriteMutation = (): UseMutationResult<
	ReportFavorite,
	Error,
	CreateFavoriteInput
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: savedReportsApi.addReportFavorite,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["reports", "favorites"] });
		},
	});
};

export const useRemoveFavoriteMutation = (): UseMutationResult<
	{ id: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: savedReportsApi.removeReportFavorite,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["reports", "favorites"] });
		},
	});
};
