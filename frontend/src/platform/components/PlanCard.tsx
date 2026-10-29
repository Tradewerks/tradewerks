import { useState, type ReactNode } from "react";
import Card from "../../components/ui/Card";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import { inputClass } from "./AuthCard";
import { moduleSourceLine } from "../breakdown";
import {
	assignable,
	chip,
	dangerButton,
	defaultTrialDate,
	flash,
	smallButton,
	statePill,
	versionLabel,
	type OpenChange,
} from "./orgDetailUi";
import { endOfDayIn, shortDateIn } from "../../lib/trialDays";
import type { PlanDraft } from "../usePlanDraft";
import type { ModuleState, OrgDetail, TierRow } from "../types";

type Grant = "tier" | "on" | "off";
// Used only when an older backend sends no breakdown.
const STATE_LABEL: Record<ModuleState, string> = {
	on: "On",
	off_by_org: "Off by org",
	not_in_plan: "Not in tier",
};

export default function PlanCard({
	detail,
	tiers,
	open,
	changed,
	draft,
	draftBar,
}: {
	detail: OrgDetail;
	tiers: TierRow[];
	/** Trial changes only; tier and module edits go through the draft. */
	open: OpenChange;
	changed: Set<string>;
	draft: PlanDraft;
	draftBar?: ReactNode;
}) {
	const e = detail.entitlement!;
	const bd = detail.breakdown ?? null;
	const grants = e.module_grants;
	const [older, setOlder] = useState(false);
	const [trialForm, setTrialForm] = useState<{ versionId: string; date: string } | null>(
		null
	);
	const pool = assignable(tiers);
	const options = pool.flatMap((t) =>
		(older ? t.versions : t.versions.slice(0, 1)).map((v) => ({
			id: v.id,
			label: `${t.label} (v${v.version})`,
		}))
	);
	const latest = pool.flatMap((t) =>
		t.versions.slice(0, 1).map((v) => ({ id: v.id, label: t.label }))
	);
	const trial = bd?.trialTier ?? null;
	const trialOn = !!trial || (detail.resolved.trialActive && !!e.trial_ends_at);
	const baseName = bd
		? `${bd.baseTier.label} v${bd.baseTier.version}`
		: (versionLabel(tiers, e.plan_version_id) ?? detail.resolved.planKey);
	const labelOf = (k: string) => detail.catalog.find((m) => m.key === k)?.label ?? k;
	const draftGrants = draft.state?.grants ?? null;
	const pbd = draft.state ? (draft.preview?.breakdown ?? null) : null;
	const orgDay = (iso: string) => shortDateIn(iso, detail.org.timezone, true);
	const trialLine = trial
		? `Trial: ${trial.label} until ${orgDay(trial.endsAt)}. ${trial.label} applies now; ${bd!.baseTier.label} applies after.`
		: trialOn
			? `Trial: ${versionLabel(tiers, e.trial_plan_version_id) ?? "tier"} until ${orgDay(e.trial_ends_at!)}`
			: "No trial";

	return (
		<Card title="Plan">
			<div className="space-y-3">
				<div className="space-y-1">
					<p className="text-sm font-medium text-text-primary">
						{baseName}
						<span className="font-normal text-text-tertiary">
							{" "}
							· set by {e.plan_source}
						</span>
					</p>
					<p className="text-sm text-text-secondary">{trialLine}</p>
				</div>
				<select
					aria-label="New tier"
					className={`${inputClass} w-full`}
					value={draft.state?.planVersionId ?? ""}
					onChange={(ev) => draft.setTier(ev.target.value || null)}
				>
					<option value="">Change tier…</option>
					{options.map((o) => (
						<option
							key={o.id}
							value={o.id}
							disabled={o.id === e.plan_version_id}
						>
							{o.label}
						</option>
					))}
				</select>
				<label className="flex items-center gap-2 text-xs text-text-secondary">
					<input
						type="checkbox"
						checked={older}
						onChange={(ev) => setOlder(ev.target.checked)}
					/>
					Show older versions
				</label>
				<div className="space-y-2 border-t border-border-subtle pt-3">
					{trialForm ? (
						<div className="flex flex-wrap items-center gap-2">
							<select
								aria-label="Trial tier"
								className={`${inputClass} w-auto`}
								value={trialForm.versionId}
								onChange={(ev) =>
									setTrialForm({
										...trialForm,
										versionId: ev.target.value,
									})
								}
							>
								{latest.map((o) => (
									<option key={o.id} value={o.id}>
										{o.label}
									</option>
								))}
							</select>
							<input
								type="date"
								aria-label="Trial ends"
								className={`${inputClass} w-auto`}
								value={trialForm.date}
								onChange={(ev) =>
									setTrialForm({
										...trialForm,
										date: ev.target.value,
									})
								}
							/>
							<button
								type="button"
								className={smallButton}
								disabled={
									!trialForm.versionId ||
									!trialForm.date
								}
								onClick={() => {
									const endsAt = endOfDayIn(
										trialForm.date,
										detail.org.timezone
									);
									open({
										change: {
											kind: "trial",
											trial: {
												planVersionId:
													trialForm.versionId,
												endsAt,
											},
										},
										title: trialOn
											? "Change trial"
											: "Start trial",
									});
									setTrialForm(null);
								}}
							>
								Review change
							</button>
							<button
								type="button"
								className={smallButton}
								onClick={() => setTrialForm(null)}
							>
								Cancel
							</button>
						</div>
					) : (
						<div className="flex gap-2">
							<button
								type="button"
								className={smallButton}
								disabled={!latest.length}
								onClick={() =>
									setTrialForm({
										versionId:
											latest[0]?.id ?? "",
										date: defaultTrialDate(),
									})
								}
							>
								{trialOn ? "Change trial" : "Start trial"}
							</button>
							{trialOn && (
								<button
									type="button"
									className={dangerButton}
									onClick={() =>
										open({
											change: {
												kind: "trial",
												trial: null,
											},
											title: "End trial",
										})
									}
								>
									End trial
								</button>
							)}
						</div>
					)}
				</div>
				<div className="space-y-1 border-t border-border-subtle pt-3">
					<p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
						What this organization gets
					</p>
					{draft.state && draft.previewPending && (
						<p className="text-xs text-text-tertiary">
							Updating preview…
						</p>
					)}
					<ul className="divide-y divide-border-subtle">
						{detail.catalog.map((m) => {
							const inDraft =
								!!draftGrants && m.key in draftGrants;
							const grant = inDraft
								? draftGrants[m.key]
								: (grants[m.key] ?? null);
							const b = bd?.modules[m.key];
							const state =
								b?.state ?? detail.resolved.modules[m.key];
							const pb = pbd?.modules[m.key];
							const moves = !!pb && pb.state !== state;
							// Off by org → Not in tier is a move, but both read "Off".
							const flips =
								!!pb && moves && (pb.state === "on") !== (state === "on");
							const marked = inDraft || moves;
							const source =
								pb && pbd
									? moduleSourceLine(pb, pbd, labelOf)
									: b && bd
										? moduleSourceLine(
												b,
												bd,
												labelOf
											)
										: state
											? STATE_LABEL[state]
											: "";
							const blocker = draft.state
								? draft.preview?.blockers.find(
										(x) => x.module === m.key
									)
								: undefined;
							const isChanged = changed.has(m.key);
							return (
								<li
									key={m.key}
									className={`flex flex-wrap items-center justify-between gap-2 py-2 ${marked ? "-ml-2 border-l-2 border-primary pl-1.5" : ""} ${isChanged ? flash : ""}`}
								>
									<div className="min-w-0 space-y-0.5">
										<div className="flex items-center gap-2">
											<p className="truncate text-sm text-text-primary">
												{m.label}
											</p>
											<span
												className={statePill(
													state ===
														"on"
												)}
											>
												{state ===
												"on"
													? "On"
													: "Off"}
											</span>
											{flips && (
												<>
													<span
														aria-hidden
														className="text-xs text-text-tertiary"
													>
														→
													</span>
													<span className="sr-only">
														becomes
													</span>
													<span
														className={statePill(
															pb.state ===
																"on",
															true
														)}
													>
														{pb.state ===
														"on"
															? "On"
															: "Off"}
													</span>
												</>
											)}
											{grant && (
												<span
													className={
														chip
													}
												>
													Override
												</span>
											)}
										</div>
										<p className="text-xs text-text-tertiary">
											{source}
											{isChanged &&
												" · Changed just now"}
										</p>
										{blocker && (
											<p className="text-xs text-warning-text">
												{
													blocker.message
												}
											</p>
										)}
									</div>
									<SegmentedToggle<Grant>
										ariaLabel={`${m.label} override`}
										value={grant ?? "tier"}
										options={[
											{
												id: "tier",
												label: "Tier default",
											},
											{
												id: "on",
												label: "Force on",
											},
											{
												id: "off",
												label: "Force off",
											},
										]}
										onChange={(id) =>
											draft.setGrant(
												m.key,
												id ===
													"tier"
													? null
													: id
											)
										}
									/>
								</li>
							);
						})}
					</ul>
				</div>
				{draftBar}
			</div>
		</Card>
	);
}
