import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Drawer from "../../components/ui/Drawer";
import ReasonField from "../../components/ui/ReasonField";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { platformError } from "../api";
import { useModuleLabel, useMoveOrgs, useMovePreview } from "../hooks";
import { primaryButton, shortDate, smallButton } from "./orgDetailUi";
import { LIMIT_LABELS } from "../limits";
import { showLimit } from "../breakdown";
import { noteReady } from "../notes";
import { toggled } from "../../lib/toggled";
import type { LimitKey, SkipCause, TierRow } from "../types";

// Matches the backend's per-move cap (tiersService MOVE_MAX).
const MOVE_MAX = 500;
const limitLabel = (key: string) => LIMIT_LABELS[key as LimitKey] ?? key;

const SKIP_COPY: Record<SkipCause, string> = {
	not_on_version: "No longer on that version",
	no_entitlement: "Has no subscription record",
	conflict: "Was changed by someone else during the move; try again",
	error: "Failed",
};

export default function MoveOrgsDialog({
	tier,
	fromVersionId,
	onClose,
}: {
	tier: TierRow;
	fromVersionId: string | null;
	onClose: () => void;
}) {
	const [from, setFrom] = useState<string | null>(fromVersionId);
	const [unticked, setUnticked] = useState<Set<string>>(new Set());
	const [reason, setReason] = useState("");
	const preview = useMovePreview(tier.key, from);
	const move = useMoveOrgs(tier.key);
	const moduleLabel = useModuleLabel();
	const { reset } = move;
	useEffect(() => {
		setFrom(fromVersionId);
		setUnticked(new Set());
		setReason("");
		reset();
	}, [fromVersionId, reset]);

	const rows = preview.data?.rows ?? [];
	const picked = rows.filter((r) => !unticked.has(r.orgId)).map((r) => r.orgId);
	const sources = tier.versions.slice(1).filter((v) => v.org_count > 0);
	const result = move.data;
	const toggle = (id: string) => setUnticked((s) => toggled(s, id));
	const ready = !!from && picked.length > 0 && noteReady(reason);
	const submit = () => {
		if (!from || !ready) return;
		move.mutate({ fromVersionId: from, orgIds: picked, reason: reason.trim() });
	};

	return (
		<Drawer
			isOpen={!!fromVersionId}
			onClose={onClose}
			side="center"
			title={`Move ${tier.label} orgs to v${tier.versions[0]?.version}`}
			footer={
				result ? (
					<div className="flex justify-end">
						<button
							type="button"
							className={smallButton}
							onClick={onClose}
						>
							Done
						</button>
					</div>
				) : (
					<div className="flex justify-end gap-2">
						<button
							type="button"
							className={smallButton}
							onClick={onClose}
						>
							Cancel
						</button>
						<button
							type="button"
							disabled={!ready || move.isPending}
							onClick={submit}
							className={primaryButton}
						>
							{`Move ${picked.length} org${picked.length === 1 ? "" : "s"}`}
						</button>
					</div>
				)
			}
		>
			{result ? (
				<div className="space-y-3 p-5 text-sm">
					<p className="font-medium text-text-primary">
						{result.moved.length} org
						{result.moved.length === 1 ? "" : "s"} moved to v
						{result.toVersion}
					</p>
					{result.skipped.length > 0 && (
						<ul className="space-y-1">
							{result.skipped.map((s) => (
								<li
									key={s.orgId}
									className="text-text-secondary"
								>
									<Link
										to={`/platform/orgs/${s.orgId}`}
										className="text-primary hover:underline"
									>
										{s.name}
									</Link>
									: {SKIP_COPY[s.cause]}
									{s.message
										? ` (${s.message})`
										: ""}
								</li>
							))}
						</ul>
					)}
				</div>
			) : (
				<div className="space-y-3 p-5">
					{sources.length > 1 && (
						<label className="flex items-center gap-2 text-sm text-text-secondary">
							From
							<select
								className="h-8 rounded-md border border-border bg-base px-2 text-sm text-text-primary"
								value={from ?? ""}
								onChange={(e) => {
									setFrom(e.target.value);
									setUnticked(new Set());
								}}
							>
								{sources.map((v) => (
									<option
										key={v.id}
										value={v.id}
									>
										v{v.version} (
										{v.org_count} orgs)
									</option>
								))}
							</select>
						</label>
					)}
					{preview.error && (
						<FormErrorBanner
							message={platformError(preview.error)}
						/>
					)}
					{preview.isLoading && (
						<p className="text-sm text-text-secondary">
							Checking each organization…
						</p>
					)}
					{preview.data?.truncated && (
						<p className="text-xs text-text-tertiary">
							Showing the first {MOVE_MAX}. Move them,
							then open this again for the rest.
						</p>
					)}
					<ul className="max-h-[50vh] space-y-2 overflow-y-auto">
						{rows.map((r) => (
							<li
								key={r.orgId}
								className="rounded-lg border border-border bg-surface p-2 text-sm"
							>
								<label className="flex items-center gap-2 font-medium text-text-primary">
									<input
										type="checkbox"
										checked={
											!unticked.has(
												r.orgId
											)
										}
										onChange={() =>
											toggle(
												r.orgId
											)
										}
									/>
									{r.name}
								</label>
								<div className="ml-6 space-y-0.5 text-xs">
									{r.trialDefers && (
										<p className="text-text-secondary">
											{
												r
													.trialDefers
													.tierLabel
											}{" "}
											trial until{" "}
											{shortDate(
												r
													.trialDefers
													.endsAt
											)}
											: nothing
											changes
											today.
										</p>
									)}
									{r.diff.gained.map((m) => (
										<p
											key={`g-${m}`}
											className="text-text-secondary"
										>{`Gains ${moduleLabel(m)}`}</p>
									))}
									{r.diff.lost.map((m) => (
										<p
											key={`l-${m}`}
											className="text-text-primary"
										>{`Loses ${moduleLabel(m)}`}</p>
									))}
									{[
										...r.diff.lowered.map(
											(l) => ({
												l,
												tone: "text-text-primary",
											})
										),
										...r.diff.raised.map(
											(l) => ({
												l,
												tone: "text-text-secondary",
											})
										),
									].map(({ l, tone }) => (
										<p
											key={`${l.key}-${tone}`}
											className={
												tone
											}
										>
											{`${limitLabel(l.key)} limit ${showLimit(l.from)} → ${showLimit(l.to)}`}
										</p>
									))}
									{r.blockers.map((b) => (
										<p
											key={`b-${b.module}`}
											className="text-warning-text"
										>
											{b.message}
										</p>
									))}
									{r.overCap.map((o) => (
										<p
											key={`o-${o.key}`}
											className="text-warning-text"
										>
											{limitLabel(
												o.key
											)}
											: {o.used}{" "}
											in use, new
											cap{" "}
											{o.limit}
										</p>
									))}
								</div>
							</li>
						))}
					</ul>
					<ReasonField
						label="Reason (required)"
						placeholder="Why move these orgs? Kept in each org's history."
						rows={2}
						value={reason}
						onChange={setReason}
					/>
					{move.error && (
						<FormErrorBanner
							message={platformError(move.error)}
						/>
					)}
				</div>
			)}
		</Drawer>
	);
}
