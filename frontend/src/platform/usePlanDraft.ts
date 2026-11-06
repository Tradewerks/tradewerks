import { useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useApplyChanges, useOrg, usePreviewChanges } from "./hooks";
import type { OrgDetail, StaffChange, StaffChangesPreview } from "./types";

type GrantValue = "on" | "off" | null;

export interface DraftState {
	planVersionId: string | null;
	/** Only modules whose grant differs from the stored one; null = back to tier default. */
	grants: Record<string, GrantValue>;
	/** The org version the draft was started from; a save from an older version must lose. */
	stamp: string;
	requestId?: string;
}

export type SaveResult =
	| { status: "saved"; preview: StaffChangesPreview | undefined; changes: StaffChange[] }
	| { status: "conflict" | "request_closed" | "error" };

type Stored = NonNullable<OrgDetail["entitlement"]>;

// The stored row can move under an open draft (another save, a refetch); entries it now
// already has would be refused as "Nothing to change", so they leave the draft.
function against(state: DraftState | null, stored: Stored | null): DraftState | null {
	if (!state || !stored) return null;
	const grants = Object.fromEntries(
		Object.entries(state.grants).filter(
			([m, g]) => (stored.module_grants[m] ?? null) !== g
		)
	);
	const planVersionId =
		state.planVersionId && state.planVersionId !== stored.plan_version_id
			? state.planVersionId
			: null;
	if (!planVersionId && Object.keys(grants).length === 0) return null;
	return { ...state, planVersionId, grants };
}

export function usePlanDraft(orgId: string, detail: OrgDetail | undefined) {
	const [raw, setRaw] = useState<DraftState | null>(null);
	const [session, setSession] = useState(0);
	const [conflict, setConflict] = useState(false);
	const [reason, setReason] = useState("");
	const [markApproved, setMarkApproved] = useState(false);
	const [rebaseFrom, setRebaseFrom] = useState<string | null>(null);
	const org = useOrg(orgId);
	const apply = useApplyChanges(orgId);
	const stored = detail?.entitlement ?? null;
	const state = useMemo(() => against(raw, stored), [raw, stored]);

	// A save made through the change dialog on this page moves the stored stamp. The
	// draft takes it only if it was current before that save; a colleague's save it
	// never saw must still conflict.
	const storedStamp = stored?.updated_at;
	if (rebaseFrom && storedStamp && storedStamp !== rebaseFrom) {
		setRebaseFrom(null);
		if (raw?.stamp === rebaseFrom) setRaw({ ...raw, stamp: storedStamp });
	}

	const changes = useMemo<StaffChange[]>(() => {
		if (!state) return [];
		const list: StaffChange[] = Object.entries(state.grants).map(([module, grant]) => ({
			kind: "grant",
			module,
			grant,
		}));
		return state.planVersionId
			? [{ kind: "plan", planVersionId: state.planVersionId }, ...list]
			: list;
	}, [state]);

	const debounced = useDebouncedValue(changes, 250);
	const preview = usePreviewChanges(orgId, state ? debounced : [], session);

	const end = () => {
		setRaw(null);
		setConflict(false);
		setReason("");
		setMarkApproved(false);
		setRebaseFrom(null);
		setSession((s) => s + 1);
	};

	const update = (edits: StaffChange[], extra: Partial<DraftState> = {}) => {
		if (!stored) return;
		setConflict(false);
		// A draft can vanish without end() (the stored row caught up), so a new one starts clean.
		if (!state) {
			setReason("");
			setMarkApproved(!!extra.requestId);
		} else if (extra.requestId && extra.requestId !== state.requestId) setMarkApproved(true);
		const next: DraftState = {
			planVersionId: null,
			grants: {},
			stamp: stored.updated_at,
			...state,
			...extra,
		};
		next.grants = { ...next.grants };
		for (const c of edits) {
			if (c.kind === "plan") next.planVersionId = c.planVersionId || null;
			else if (c.kind === "grant") next.grants[c.module] = c.grant;
		}
		if (against(next, stored)) setRaw(next);
		else end();
	};

	const save = async (reason: string, upgradeRequestId?: string): Promise<SaveResult> => {
		if (!state) return { status: "error" };
		setConflict(false);
		const sent = changes;
		const projected = preview.data;
		try {
			await apply.mutateAsync({
				changes: sent,
				reason,
				expectedUpdatedAt: state.stamp,
				upgradeRequestId,
			});
			end();
			return { status: "saved", preview: projected, changes: sent };
		} catch (err) {
			if (!isAxiosError(err) || err.response?.status !== 409)
				return { status: "error" };
			if (err.response.data?.error?.code === "REQUEST_CLOSED")
				return { status: "request_closed" };
			const fresh = await org.refetch();
			const stamp = fresh.data?.entitlement?.updated_at;
			if (stamp) setRaw((d) => d && { ...d, stamp });
			setConflict(true);
			void preview.refetch();
			return { status: "conflict" };
		}
	};

	return {
		state,
		changes,
		setTier: (planVersionId: string | null) =>
			update([{ kind: "plan", planVersionId: planVersionId ?? "" }]),
		setGrant: (module: string, grant: GrantValue) =>
			update([{ kind: "grant", module, grant }]),
		seed: (change: StaffChange, opts: { requestId?: string } = {}) =>
			update([change], opts.requestId ? { requestId: opts.requestId } : {}),
		discard: end,
		preview: state ? preview.data : undefined,
		previewPending: !!state && (debounced !== changes || preview.isFetching),
		previewError: state ? preview.error : null,
		save,
		saving: apply.isPending,
		saveError: apply.error,
		conflict,
		reason,
		setReason,
		markApproved,
		setMarkApproved,
		rebase: (from: string | undefined) => {
			if (raw && from) setRebaseFrom(from);
		},
	};
}

export type PlanDraft = ReturnType<typeof usePlanDraft>;
