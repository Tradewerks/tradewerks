import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { platform } from "./api";
import type { RequestResolution, StaffChange, TierFilter } from "./types";

export const useOrgs = (q: string, page: number, trialEnding = false, tier?: TierFilter) =>
	useQuery({
		queryKey: ["platform", "orgs", q, page, trialEnding, tier?.key ?? null, tier?.version ?? null],
		queryFn: () => platform.orgs(q, page, trialEnding, tier),
		placeholderData: keepPreviousData,
	});
export const useOrg = (id: string) =>
	useQuery({ queryKey: ["platform", "org", id], queryFn: () => platform.org(id) });
export const useOrgHistory = (id: string) =>
	useQuery({
		queryKey: ["platform", "org-history", id],
		queryFn: () => platform.orgHistory(id),
	});
export const useTiers = () =>
	useQuery({ queryKey: ["platform", "tiers"], queryFn: platform.tiers, staleTime: 60_000 });
export const useStaff = () =>
	useQuery({ queryKey: ["platform", "staff"], queryFn: platform.staff });
export const useStaffActivity = () =>
	useQuery({ queryKey: ["platform", "staff-activity"], queryFn: platform.staffActivity });

export const usePreviewChange = (orgId: string) =>
	useMutation({ mutationFn: (change: StaffChange) => platform.preview(orgId, change) });

// onSettled, not onSuccess: after a 409 the next try must use the fresh row.
function useOrgMutation<A, R>(orgId: string, fn: (a: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () => {
			qc.invalidateQueries({ queryKey: ["platform", "org", orgId] });
			qc.invalidateQueries({ queryKey: ["platform", "org-history", orgId] });
			qc.invalidateQueries({ queryKey: ["platform", "orgs"] });
			qc.invalidateQueries({ queryKey: ["platform", "requests"] });
		},
	});
}

export const useCreateOrg = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: platform.createOrg,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "orgs"] }),
	});
};
export const useResendOrgInvite = (orgId: string) =>
	useOrgMutation(orgId, () => platform.resendOrgInvite(orgId));

export const useApplyChange = (orgId: string) =>
	useOrgMutation(
		orgId,
		(v: {
			change: StaffChange;
			reason: string;
			expectedUpdatedAt?: string;
			upgradeRequestId?: string;
		}) =>
			platform.apply(
				orgId,
				v.change,
				v.reason,
				v.expectedUpdatedAt,
				v.upgradeRequestId
			)
	);

export const useApplyChanges = (orgId: string) =>
	useOrgMutation(
		orgId,
		(v: {
			changes: StaffChange[];
			reason: string;
			expectedUpdatedAt?: string;
			upgradeRequestId?: string;
		}) => platform.applyChanges(orgId, v)
	);

// The session key keeps the last projection on screen while the next one loads, but never
// carries one draft's projection into the next draft.
export const usePreviewChanges = (orgId: string, changes: StaffChange[], session: number) =>
	useQuery({
		queryKey: ["platform", "changes-preview", orgId, session, changes],
		queryFn: () => platform.previewChanges(orgId, changes),
		enabled: changes.length > 0,
		placeholderData: (prev, prevQuery) =>
			prevQuery?.queryKey[3] === session ? prev : undefined,
		retry: false,
	});

function useStaffMutation<A, R>(fn: (a: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["platform", "staff"] });
			qc.invalidateQueries({ queryKey: ["platform", "staff-activity"] });
		},
	});
}
export const useInviteStaff = () => useStaffMutation(platform.invite);
export const useResendInvite = () => useStaffMutation(platform.resendInvite);
export const useSetStaffStatus = () =>
	useStaffMutation((v: { id: string; status: "active" | "disabled" }) =>
		platform.setStaffStatus(v.id, v.status)
	);
export const useResetStaffMfa = () => useStaffMutation(platform.resetStaffMfa);

export const useCatalog = () =>
	useQuery({
		queryKey: ["platform", "catalog"],
		queryFn: platform.catalog,
		staleTime: Infinity,
	});
export function useModuleLabel() {
	const catalog = useCatalog();
	return (key: string) => catalog.data?.find((m) => m.key === key)?.label ?? key;
}
export const useTierHistory = (key: string) =>
	useQuery({
		queryKey: ["platform", "tier-history", key],
		queryFn: () => platform.tierHistory(key),
	});
export const useMovePreview = (key: string, from: string | null) =>
	useQuery({
		queryKey: ["platform", "move-preview", key, from],
		queryFn: () => platform.movePreview(key, from!),
		enabled: !!from,
	});
export const useRequests = (status: "open" | "all", orgId?: string, page = 1) =>
	useQuery({
		queryKey: ["platform", "requests", status, orgId ?? null, page],
		queryFn: () => platform.requests({ status, orgId, page }),
		placeholderData: keepPreviousData,
	});
export const useOpenRequestCount = () =>
	useQuery({
		queryKey: ["platform", "requests", "open-count"],
		queryFn: platform.openRequestCount,
		staleTime: 60_000,
	});
export function useOpenRequestFor(orgId: string) {
	const q = useRequests("open", orgId);
	return q.data?.rows[0] ?? null;
}

export function useTierMutation<A, R>(fn: (a: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () => {
			qc.invalidateQueries({ queryKey: ["platform", "tiers"] });
			qc.invalidateQueries({ queryKey: ["platform", "tier-history"] });
		},
	});
}
export function useMoveOrgs(key: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (b: { fromVersionId: string; orgIds: string[]; reason: string }) =>
			platform.moveOrgs(key, b),
		onSettled: () => {
			for (const k of [
				"tiers",
				"tier-history",
				"orgs",
				"org",
				"org-history",
				"move-preview",
			])
				qc.invalidateQueries({ queryKey: ["platform", k] });
		},
	});
}
export function useResolveRequest() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { id: string; status: RequestResolution; note: string }) =>
			platform.resolveRequest(v.id, v.status, v.note),
		onSettled: () => {
			qc.invalidateQueries({ queryKey: ["platform", "requests"] });
			qc.invalidateQueries({ queryKey: ["platform", "org-history"] });
		},
	});
}
