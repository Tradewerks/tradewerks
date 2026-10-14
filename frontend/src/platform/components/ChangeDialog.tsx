import { useEffect, useState } from "react";
import { isAxiosError } from "axios";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ReasonField from "../../components/ui/ReasonField";
import { platformError } from "../api";
import { useApplyChange, useOrg, usePreviewChange, useTiers } from "../hooks";
import type { StaffChange, StaffChangePreview } from "../types";
import { changesNothing, diffItems, findVersion, isLosing, tierContentsDiff } from "../breakdown";
import ChangeSummary, { Section } from "./ChangeSummary";
import { noteReady, REASON_TOO_SHORT } from "../notes";

export default function ChangeDialog({
	orgId,
	change,
	title,
	expectedUpdatedAt,
	requestId,
	markApprovedByDefault,
	onApplied,
	onClose,
}: {
	orgId: string;
	change: StaffChange | null;
	title: string;
	/** The org version the page showed when the change was started. */
	expectedUpdatedAt?: string;
	/** Open upgrade request on this org; shows the "Mark request approved" box. */
	requestId?: string;
	/** Whether the "Mark request approved" box starts ticked. */
	markApprovedByDefault?: boolean;
	/** `appliedAgainst` is the org version the save was checked against (fresh after a 409). */
	onApplied?: (preview: StaffChangePreview, appliedAgainst?: string) => void;
	onClose: () => void;
}) {
	const org = useOrg(orgId);
	const preview = usePreviewChange(orgId);
	const apply = useApplyChange(orgId);
	const [reason, setReason] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [stamp, setStamp] = useState(expectedUpdatedAt);
	const [markApproved, setMarkApproved] = useState(!!markApprovedByDefault);
	const { mutate: runPreview, reset: resetPreview } = preview;
	const { reset: resetApply } = apply;

	useEffect(() => {
		if (!change) return;
		setReason("");
		setLocalError(null);
		setStamp(expectedUpdatedAt);
		setMarkApproved(!!markApprovedByDefault);
		resetApply();
		resetPreview();
		runPreview(change);
	}, [
		change,
		expectedUpdatedAt,
		markApprovedByDefault,
		runPreview,
		resetPreview,
		resetApply,
	]);

	const labels = new Map((org.data?.catalog ?? []).map((m) => [m.key, m.label]));
	const moduleLabel = (key: string) => labels.get(key) ?? key;
	const p = preview.data;
	const tiers = useTiers();
	const trial = org.data?.breakdown?.trialTier ?? null;
	const deferred = change?.kind === "plan" && !!trial;
	const afterTrial = (() => {
		if (!deferred || change?.kind !== "plan") return [];
		const from = findVersion(tiers.data ?? [], org.data?.entitlement?.plan_version_id);
		const to = findVersion(tiers.data ?? [], change.planVersionId);
		return from && to ? diffItems(tierContentsDiff(from, to), moduleLabel) : [];
	})();
	const trialDate = trial
		? new Date(trial.endsAt).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			})
		: "";
	const losing = isLosing(p);

	const body = !p ? (
		<p className="text-sm text-text-secondary">
			{preview.isError
				? "Could not check this change."
				: "Checking what this changes…"}
		</p>
	) : (
		<div className="space-y-3">
			{deferred && trial && (
				<p className="text-sm text-text-primary">
					{trial.label} trial applies until {trialDate}, so nothing
					changes today.
				</p>
			)}
			{afterTrial.length > 0 && (
				<Section title="After the trial ends">
					{afterTrial.map((t) => (
						<li key={t}>{t}</li>
					))}
					<li className="text-xs text-text-tertiary">
						Tier contents, before this organization's overrides.
					</li>
				</Section>
			)}
			<ChangeSummary preview={p} moduleLabel={moduleLabel} />
			{changesNothing(p) && (
				<p className="text-sm text-text-secondary">
					No change to modules or limits
					{deferred ? " today" : ""}.
				</p>
			)}
			{losing && (
				<p className="text-sm text-text-tertiary">
					The organization's admins get one notification about this
					change.
				</p>
			)}
			<ReasonField
				label="Reason (required)"
				placeholder="Why this change? It is kept in the history."
				rows={3}
				value={reason}
				onChange={setReason}
			/>
			{requestId && (
				<label className="flex items-center gap-2 text-sm text-text-primary">
					<input
						type="checkbox"
						checked={markApproved}
						onChange={(e) => setMarkApproved(e.target.checked)}
					/>
					Mark request approved
				</label>
			)}
			{requestId && markApproved && (
				<p className="text-xs text-text-tertiary">
					The requester sees this reason in their notification.
				</p>
			)}
		</div>
	);

	const onConfirm = async () => {
		if (!change || !p) return;
		if (!noteReady(reason)) {
			setLocalError(REASON_TOO_SHORT);
			return;
		}
		setLocalError(null);
		try {
			await apply.mutateAsync({
				change,
				reason: reason.trim(),
				expectedUpdatedAt: stamp,
				upgradeRequestId: requestId && markApproved ? requestId : undefined,
			});
			onApplied?.(p, stamp);
			onClose();
		} catch (err) {
			if (!isAxiosError(err) || err.response?.status !== 409) return; // shown from apply.error
			if (err.response?.data?.error?.code === "REQUEST_CLOSED") {
				setMarkApproved(false);
				setLocalError(
					"This request was already closed by someone else. The box is now unticked; apply again to make the change without closing it."
				);
				return;
			}
			// Someone else saved first: show what the change does now, then let them apply against that.
			const fresh = await org.refetch();
			setStamp(fresh.data?.entitlement?.updated_at);
			runPreview(change);
			setLocalError(
				"Someone else changed this organization. The preview above is updated; check it and apply again."
			);
		}
	};

	const error =
		localError ??
		(apply.error
			? platformError(apply.error)
			: preview.error
				? platformError(preview.error)
				: null);

	return (
		<ConfirmDialog
			open={!!change}
			title={title}
			body={body}
			confirmLabel="Apply change"
			tone={losing ? "destructive" : "primary"}
			pending={preview.isPending || apply.isPending}
			error={error}
			onConfirm={onConfirm}
			onCancel={onClose}
		/>
	);
}
