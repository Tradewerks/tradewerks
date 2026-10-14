import { useState } from "react";
import { isAxiosError } from "axios";
import ReasonField from "../../components/ui/ReasonField";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { platformError } from "../api";
import { changesNothing, diffItems, findVersion, isLosing, tierContentsDiff } from "../breakdown";
import { noteReady, REASON_TOO_SHORT } from "../notes";
import type { PlanDraft, SaveResult } from "../usePlanDraft";
import type { OrgDetail, TierRow } from "../types";
import ChangeSummary, { Section } from "./ChangeSummary";
import { textButton, versionLabel } from "./orgDetailUi";

const saveTone = {
	primary: "bg-primary hover:enabled:bg-primary-hover",
	destructive: "bg-error hover:enabled:bg-error-strong",
};

export default function PlanDraftBar({
	draft,
	detail,
	tiers,
	requestId,
	onSaved,
}: {
	draft: PlanDraft;
	detail: OrgDetail;
	tiers: TierRow[];
	/** Open upgrade request on this org; shows the "Mark request approved" box. */
	requestId?: string;
	onSaved: (result: Extract<SaveResult, { status: "saved" }>) => void;
}) {
	const state = draft.state!;
	const p = draft.preview;
	// Held by the draft, not here: a save elsewhere on the page remounts this bar.
	const { reason, setReason, markApproved, setMarkApproved } = draft;
	const [localError, setLocalError] = useState<string | null>(null);

	const moduleLabel = (k: string) => detail.catalog.find((m) => m.key === k)?.label ?? k;
	const bd = detail.breakdown ?? null;
	const currentTier = bd
		? `${bd.baseTier.label} v${bd.baseTier.version}`
		: versionLabel(tiers, detail.entitlement?.plan_version_id ?? null);
	const overrides = Object.keys(state.grants).length;
	const summary = [
		state.planVersionId &&
			`Tier ${currentTier ?? "current"} → ${versionLabel(tiers, state.planVersionId) ?? "new tier"}`,
		overrides > 0 && `${overrides} override${overrides === 1 ? "" : "s"}`,
	]
		.filter(Boolean)
		.join(" · ");

	const trial = bd?.trialTier ?? null;
	const deferred = !!trial && !!state.planVersionId;
	const afterTrial = (() => {
		if (!deferred) return [];
		const from = findVersion(tiers, detail.entitlement?.plan_version_id);
		const to = findVersion(tiers, state.planVersionId);
		return from && to ? diffItems(tierContentsDiff(from, to), moduleLabel) : [];
	})();
	const losing = isLosing(p);

	const onSave = async () => {
		if (!noteReady(reason)) {
			setLocalError(REASON_TOO_SHORT);
			return;
		}
		setLocalError(null);
		const r = await draft.save(
			reason.trim(),
			requestId && markApproved ? requestId : undefined
		);
		if (r.status === "saved") onSaved(r);
		else if (r.status === "request_closed") {
			setMarkApproved(false);
			setLocalError(
				"This request was already closed by someone else. The box is now unticked; save again to make the change without closing it."
			);
		}
	};

	const saveError =
		draft.saveError &&
		!(isAxiosError(draft.saveError) && draft.saveError.response?.status === 409)
			? platformError(draft.saveError)
			: null;
	const error =
		localError ??
		saveError ??
		(draft.previewError ? platformError(draft.previewError) : null) ??
		(draft.conflict
			? "Someone else changed this organization. The projection is updated; check it and save again."
			: null);

	return (
		<div
			aria-label="Unsaved plan changes"
			role="region"
			className="sticky bottom-0 -mx-4 -mb-4 space-y-3 rounded-b-lg border-t border-border bg-surface p-4 lg:static"
		>
			<p className="text-sm font-medium text-text-primary">{summary}</p>
			{deferred && trial && (
				<p className="text-sm text-text-primary">
					{trial.label} trial applies until{" "}
					{new Date(trial.endsAt).toLocaleDateString(undefined, {
						month: "short",
						day: "numeric",
					})}
					; the tier change takes effect after.
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
			{p ? (
				<>
					<ChangeSummary preview={p} moduleLabel={moduleLabel} />
					{changesNothing(p) && (
						<p className="text-sm text-text-secondary">
							No change to modules or limits
							{deferred ? " today" : ""}.
						</p>
					)}
					{losing && (
						<p className="text-sm text-text-tertiary">
							The organization's admins get one
							notification about this change.
						</p>
					)}
				</>
			) : (
				!draft.previewError && (
					<p className="text-sm text-text-secondary">
						Checking what this changes…
					</p>
				)
			)}
			<ReasonField
				label="Reason (required)"
				placeholder="Why this change? It is kept in the history."
				rows={2}
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
			<FormErrorBanner message={error} />
			<div className="flex items-center justify-end gap-3">
				<button
					type="button"
					className={textButton}
					disabled={draft.saving}
					onClick={draft.discard}
				>
					Discard
				</button>
				<button
					type="button"
					className={`h-8 rounded-md px-3 text-sm font-medium text-white transition-colors duration-150 ease-out disabled:opacity-50 ${saveTone[losing ? "destructive" : "primary"]}`}
					disabled={draft.previewPending || draft.saving || !p}
					onClick={onSave}
				>
					Save changes
				</button>
			</div>
		</div>
	);
}
