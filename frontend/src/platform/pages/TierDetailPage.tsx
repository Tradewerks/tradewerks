import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import Card from "../../components/ui/Card";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { useToast } from "../../components/ui/useToast";
import { platform, platformError } from "../api";
import { useCatalog, useModuleLabel, useTierHistory, useTierMutation, useTiers } from "../hooks";
import RecordHeader from "../components/RecordHeader";
import HistoryList from "../components/HistoryList";
import MoveOrgsDialog from "../components/MoveOrgsDialog";
import TierActionDialog, { type TierAction } from "../components/TierActionDialog";
import TierContentsForm from "../components/TierContentsForm";
import TierOrgsPanel from "../components/TierOrgsPanel";
import {
	canvasChip,
	chip,
	isAssignable,
	primaryButton,
	shortDate,
	smallButton,
} from "../components/orgDetailUi";
import { HEADER_BTN_SECONDARY, HEADER_META } from "../../components/ui/headerActions";
import { showLimit } from "../breakdown";
import { LIMIT_KEYS, LIMIT_LABELS } from "../limits";
import { tierFlags } from "../tierForm";
import type { TierContents, TierRow } from "../types";

const TIER_EVENT_LABELS: Record<string, string> = {
	"plan.created": "Tier created",
	"plan.updated": "Tier settings changed",
	"plan.version_created": "New version",
	"plan.orgs_moved": "Orgs moved to the latest version",
};

const contentsOf = (v: TierRow["versions"][number]): TierContents => ({
	modules: v.modules,
	limits: v.limits as TierContents["limits"],
});

type TierTab = "versions" | "orgs" | "history";

export default function TierDetailPage() {
	const { tierKey = "" } = useParams();
	const [params, setParams] = useSearchParams();
	const tabParam = params.get("tab");
	const tab: TierTab = tabParam === "history" || tabParam === "orgs" ? tabParam : "versions";
	const orgVersion = Number(params.get("version")) || null;
	const showTab = (id: TierTab, version: number | null = null) =>
		setParams(
			{
				...(id !== "versions" && { tab: id }),
				...(id === "orgs" && version && { version: String(version) }),
			},
			{ replace: true }
		);
	const tiers = useTiers();
	const catalog = useCatalog();
	const history = useTierHistory(tierKey);
	const moduleLabel = useModuleLabel();
	const toast = useToast();
	const [editing, setEditing] = useState(false);
	const [action, setAction] = useState<TierAction | null>(null);
	const [moveFrom, setMoveFrom] = useState<string | null>(null);
	const save = useTierMutation((b: TierContents & { note: string }) =>
		platform.createVersion(tierKey, b)
	);

	const tier = tiers.data?.find((t) => t.key === tierKey);
	if (tiers.isLoading)
		return <div className="h-24 animate-pulse rounded-lg bg-surface-inset" />;
	if (!tier)
		return (
			<div className="space-y-3">
				<Link
					to="/platform/tiers"
					className="text-sm text-primary hover:underline"
				>
					Back to tiers
				</Link>
				{tiers.error ? (
					<FormErrorBanner message={platformError(tiers.error)} />
				) : (
					<p className="text-sm text-text-secondary">
						Tier not found
					</p>
				)}
			</div>
		);
	const latest = tier.versions[0];
	const older = tier.versions.slice(1).filter((v) => v.org_count > 0);
	const olderOrgs = older.reduce((n, v) => n + v.org_count, 0);
	// Versions are newest first, so the last one is the oldest still in use.
	const oldest = older[older.length - 1];
	const editable = isAssignable(tier);
	const actions: { id: TierAction; text: string; show: boolean }[] = [
		{ id: "rename", text: "Rename", show: true },
		{
			id: "signupDefault",
			text: "Make signup default",
			show: editable && !tier.is_signup_default,
		},
		{ id: "archive", text: "Archive", show: !tier.archived_at && tier.assignable },
		{ id: "unarchive", text: "Unarchive", show: !!tier.archived_at },
	];

	return (
		<div className="space-y-4">
			<RecordHeader
				title={tier.label}
				subtitle={tier.key}
				badges={
					<>
						<span className={canvasChip}>Latest v{latest?.version}</span>
						{tierFlags(tier).map((f) => (
							<span key={f} className={canvasChip}>
								{f}
							</span>
						))}
					</>
				}
				actions={
					<>
						{editable && (
							<button
								type="button"
								className={primaryButton}
								onClick={() => setEditing(true)}
							>
								Edit
							</button>
						)}
						{actions
							.filter((a) => a.show)
							.map((a) => (
								<button
									key={a.id}
									type="button"
									className={smallButton}
									onClick={() => setAction(a.id)}
								>
									{a.text}
								</button>
							))}
					</>
				}
			/>
			{olderOrgs > 0 && editable && (
				<div
					role="status"
					className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-inset p-3 text-sm"
				>
					<span className="text-text-primary">
						{olderOrgs} org{olderOrgs === 1 ? " is" : "s are"}{" "}
						on older versions.
					</span>
					<button
						type="button"
						className={smallButton}
						onClick={() => setMoveFrom(oldest.id)}
					>
						Move orgs…
					</button>
				</div>
			)}
			<SegmentedToggle<TierTab>
				ariaLabel="Tier view"
				value={tab}
				options={[
					{ id: "versions", label: "Versions" },
					{
						id: "orgs",
						label: "Organizations",
						badge: tier.versions.reduce((n, v) => n + v.org_count, 0),
					},
					{ id: "history", label: "History" },
				]}
				onChange={(id) => showTab(id)}
			/>
			{tab === "orgs" ? (
				<TierOrgsPanel
					tier={tier}
					version={orgVersion}
					onVersionChange={(v) => showTab("orgs", v)}
				/>
			) : tab === "history" ? (
				<HistoryList
					rows={history.data}
					isLoading={history.isLoading}
					error={history.error}
					eventLabels={TIER_EVENT_LABELS}
				/>
			) : (
				<ul className="space-y-3">
					{tier.versions.map((v, i) => (
						<li key={v.id}>
							<Card
								title={`v${v.version}`}
								headerAction={
									<div className="flex flex-wrap items-center gap-2">
										{i === 0 && <span className={chip}>Latest</span>}
										{v.org_count > 0 ? (
											<button
												type="button"
												className={`${HEADER_BTN_SECONDARY} tabular-nums`}
												onClick={() => showTab("orgs", v.version)}
											>
												{v.org_count} org{v.org_count === 1 ? "" : "s"}
												{v.trial_org_count > 0 && ` · ${v.trial_org_count} on trial`}
											</button>
										) : (
											<span className={HEADER_META}>0 orgs</span>
										)}
										<span className={HEADER_META}>{shortDate(v.created_at)}</span>
									</div>
								}
							>
								<div className="space-y-3">
									{v.note && (
										<p className="text-sm text-text-secondary">
											{v.note}
										</p>
									)}
									<div className="flex flex-wrap gap-1">
										{v.modules.length === 0 ? (
											<span className="text-xs text-text-tertiary">
												No paid features or
												optional modules
											</span>
										) : (
											v.modules.map((m) => (
												<span
													key={m}
													className={
														chip
													}
												>
													{moduleLabel(
														m
													)}
												</span>
											))
										)}
									</div>
									<dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
										{LIMIT_KEYS.map((k) => (
											<div key={k}>
												<dt className="text-text-tertiary">
													{
														LIMIT_LABELS[
															k
														]
													}
												</dt>
												<dd className="text-text-primary tabular-nums">
													{showLimit(
														v
															.limits[
															k
														] ??
															null
													)}
												</dd>
											</div>
										))}
									</dl>
									{i > 0 && v.org_count > 0 && editable && (
										<button
											type="button"
											className={smallButton}
											onClick={() =>
												setMoveFrom(v.id)
											}
										>
											Move orgs…
										</button>
									)}
								</div>
							</Card>
						</li>
					))}
				</ul>
			)}
			<TierContentsForm
				open={editing}
				mode="version"
				title={`New version of ${tier.label}`}
				catalog={catalog.data ?? []}
				initial={latest ? contentsOf(latest) : null}
				pending={save.isPending}
				error={save.error ? platformError(save.error) : null}
				onClose={() => setEditing(false)}
				onSubmit={(v) =>
					save.mutate(v, {
						onSuccess: () => {
							toast.success(
								`${tier.label} v${(latest?.version ?? 0) + 1} saved`
							);
							setEditing(false);
						},
					})
				}
			/>
			<TierActionDialog
				key={action ?? "none"}
				tier={tier}
				action={action}
				onClose={() => setAction(null)}
			/>
			<MoveOrgsDialog
				tier={tier}
				fromVersionId={moveFrom}
				onClose={() => setMoveFrom(null)}
			/>
		</div>
	);
}
