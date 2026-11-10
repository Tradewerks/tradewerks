import axios, { AxiosError } from "axios";
import { usePlatformAuth } from "./store";
import type {
	CreateOrgBody,
	CatalogModule,
	HistoryRow,
	MovePreview,
	MoveResult,
	RequestPage,
	RequestResolution,
	TierContents,
	TierPatch,
	OrgDetail,
	OrgListPage,
	TierFilter,
	ResolvedEntitlements,
	StaffChange,
	StaffChangePreview,
	StaffChangesPreview,
	StaffActivityRow,
	StaffRow,
	StaffSession,
	TierRow,
} from "./types";

export const platformApi = axios.create({ baseURL: import.meta.env.VITE_BACKEND_URL });

platformApi.interceptors.request.use((config) => {
	const token = usePlatformAuth.getState().token;
	if (token && !config.headers.Authorization)
		config.headers.Authorization = `Bearer ${token}`;
	return config;
});

platformApi.interceptors.response.use(
	(r) => r,
	(err: AxiosError) => {
		const isAuthCall = /^\/platform\/(auth|setup|invites)/.test(err.config?.url ?? "");
		if (err.response?.status === 401 && !isAuthCall)
			usePlatformAuth.getState().signOut("expired");
		return Promise.reject(err);
	}
);

export function platformError(err: unknown): string {
	const msg = (err as AxiosError<{ error?: { message?: string } }>)?.response?.data?.error
		?.message;
	return msg ?? "Something went wrong. Try again.";
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data);
const pendingHeader = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
const PATCH_PATH = { plan: "plan", trial: "trial", grant: "modules", limit: "limits" } as const;

export const platform = {
	setupAvailable: () => data<{ available: boolean }>(platformApi.get("/platform/setup")),
	setup: (b: { code: string; email: string; name: string; password: string }) =>
		data<{ pendingToken: string }>(platformApi.post("/platform/setup", b)),
	login: (email: string, password: string) =>
		data<{ stage: "mfa"; pendingToken: string } | { stage: "enroll_email" }>(
			platformApi.post("/platform/auth/login", { email, password })
		),
	exchangeEnrollLink: (token: string) =>
		data<{ pendingToken: string }>(
			platformApi.post("/platform/auth/mfa/enroll/link", { token })
		),
	verifyMfa: (pending: string, b: { code?: string; recoveryCode?: string }) =>
		data<StaffSession>(
			platformApi.post("/platform/auth/mfa", b, pendingHeader(pending))
		),
	enrollStart: (pending: string) =>
		data<{ otpAuthUri: string; secret: string }>(
			platformApi.post(
				"/platform/auth/mfa/enroll/start",
				{},
				pendingHeader(pending)
			)
		),
	enrollFinish: (pending: string, code: string) =>
		data<StaffSession & { recoveryCodes: string[] }>(
			platformApi.post(
				"/platform/auth/mfa/enroll",
				{ code },
				pendingHeader(pending)
			)
		),
	previewInvite: (token: string) =>
		data<{ email: string; name: string }>(
			platformApi.post("/platform/invites/preview", { token })
		),
	acceptInvite: (b: { token: string; name: string; password: string }) =>
		data<{ pendingToken: string }>(platformApi.post("/platform/invites/accept", b)),
	staff: () => data<StaffRow[]>(platformApi.get("/platform/staff")),
	staffActivity: () => data<StaffActivityRow[]>(platformApi.get("/platform/staff/activity")),
	invite: (b: { email: string; name: string }) =>
		data<{ staff: StaffRow; inviteUrl: string }>(
			platformApi.post("/platform/staff", b)
		),
	resendInvite: (id: string) =>
		data<{ inviteUrl: string }>(
			platformApi.post(`/platform/staff/${id}/resend-invite`)
		),
	setStaffStatus: (id: string, status: "active" | "disabled") =>
		data<null>(platformApi.patch(`/platform/staff/${id}`, { status })),
	resetStaffMfa: (id: string) =>
		data<null>(platformApi.post(`/platform/staff/${id}/reset-mfa`)),
	orgs: (q: string, page: number, trialEnding = false, tier?: TierFilter) =>
		data<OrgListPage>(
			platformApi.get("/platform/orgs", {
				params: {
					q,
					page,
					...(trialEnding && { trial_ending_within_days: 7 }),
					...(tier && { tier: tier.key, ...(tier.version && { version: tier.version }) }),
				},
			})
		),
	createOrg: (b: CreateOrgBody) =>
		data<{ id: string; inviteUrl: string }>(platformApi.post("/platform/orgs", b)),
	resendOrgInvite: (orgId: string) =>
		data<{ inviteUrl: string }>(
			platformApi.post(`/platform/orgs/${orgId}/admin-invite/resend`)
		),
	org: (id: string) => data<OrgDetail>(platformApi.get(`/platform/orgs/${id}`)),
	orgHistory: (id: string) =>
		data<HistoryRow[]>(platformApi.get(`/platform/orgs/${id}/history`)),
	tiers: () => data<TierRow[]>(platformApi.get("/platform/plans")),
	preview: (id: string, change: StaffChange) =>
		data<StaffChangePreview>(
			platformApi.post(`/platform/orgs/${id}/preview`, { change })
		),
	previewChanges: (id: string, changes: StaffChange[]) =>
		data<StaffChangesPreview>(
			platformApi.post(`/platform/orgs/${id}/changes/preview`, { changes })
		),
	applyChanges: (
		id: string,
		b: {
			changes: StaffChange[];
			reason: string;
			expectedUpdatedAt?: string;
			upgradeRequestId?: string;
		}
	) => data<ResolvedEntitlements>(platformApi.post(`/platform/orgs/${id}/changes`, b)),
	catalog: () => data<CatalogModule[]>(platformApi.get("/platform/plans/catalog")),
	createTier: (b: TierContents & { key: string; label: string; note: string }) =>
		data<unknown>(platformApi.post("/platform/plans", b)),
	patchTier: (key: string, patch: TierPatch, reason: string) =>
		data<unknown>(platformApi.patch(`/platform/plans/${key}`, { ...patch, reason })),
	createVersion: (key: string, b: TierContents & { note: string }) =>
		data<unknown>(platformApi.post(`/platform/plans/${key}/versions`, b)),
	tierHistory: (key: string) =>
		data<HistoryRow[]>(platformApi.get(`/platform/plans/${key}/history`)),
	movePreview: (key: string, from: string) =>
		data<MovePreview>(
			platformApi.get(`/platform/plans/${key}/move-orgs/preview`, {
				params: { from },
			})
		),
	moveOrgs: (key: string, b: { fromVersionId: string; orgIds: string[]; reason: string }) =>
		data<MoveResult>(platformApi.post(`/platform/plans/${key}/move-orgs`, b)),
	requests: (q: { status: "open" | "all"; orgId?: string; page?: number }) =>
		data<RequestPage>(platformApi.get("/platform/upgrade-requests", { params: q })),
	openRequestCount: () =>
		data<{ count: number }>(platformApi.get("/platform/upgrade-requests/open-count")),
	resolveRequest: (id: string, status: RequestResolution, note: string) =>
		data<null>(platformApi.patch(`/platform/upgrade-requests/${id}`, { status, note })),
	apply: (
		id: string,
		change: StaffChange,
		reason: string,
		expectedUpdatedAt?: string,
		upgradeRequestId?: string
	) => {
		const { kind, ...rest } = change;
		return data<ResolvedEntitlements>(
			platformApi.patch(`/platform/orgs/${id}/${PATCH_PATH[kind]}`, {
				...rest,
				reason,
				expectedUpdatedAt,
				upgradeRequestId,
			})
		);
	},
};
