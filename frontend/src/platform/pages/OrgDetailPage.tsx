import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { AxiosError } from "axios";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { useToast } from "../../components/ui/useToast";
import { appliedMessage, changedKeys } from "../breakdown";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ChangeDialog from "../components/ChangeDialog";
import HistoryList from "../components/HistoryList";
import LimitsCard from "../components/LimitsCard";
import PlanCard from "../components/PlanCard";
import PlanDraftBar from "../components/PlanDraftBar";
import RequestBanner from "../components/RequestBanner";
import ResolveRequestDialog from "../components/ResolveRequestDialog";
import { UsageCell } from "../components/UsageCell";
import { card, cardTitle, chip, shortDate, versionLabel } from "../components/orgDetailUi";
import { LIMIT_KEYS, LIMIT_LABELS } from "../limits";
import { platformError } from "../api";
import { useOpenRequestFor, useOrg, useOrgHistory, useTiers } from "../hooks";
import { usePlanDraft, type SaveResult } from "../usePlanDraft";
import { useUnsavedGuard } from "../useUnsavedGuard";
import type {
	EntitlementDiff,
	OrgDetail,
	RequestResolution,
	StaffChange,
	StaffChangePreview,
} from "../types";

const ORG_EVENT_LABELS: Record<string, string> = {
	"org_entitlement.plan_changed": "Tier changed",
	"org_entitlement.trial_changed": "Trial changed",
	"org_entitlement.grant_changed": "Module forced on/off",
	"org_entitlement.limit_changed": "Limit override changed",
	"org_entitlement.modules_changed": "Modules switched by the org",
	"upgrade_request.created": "Subscription request filed",
	"upgrade_request.withdrawn": "Request withdrawn",
	"upgrade_request.approved": "Request approved",
	"upgrade_request.declined": "Request declined",
};

type DialogTarget = { change: StaffChange; title: string } | null;
const NO_DIFF: EntitlementDiff = { lost: [], gained: [], lowered: [], raised: [] };
const isDraftable = (c: StaffChange) => c.kind === "plan" || c.kind === "grant";
type DialogState = {
	change: StaffChange;
	title: string;
	expectedUpdatedAt?: string;
	// The request the dialog was opened for; a stale one must fail with REQUEST_CLOSED, not
	// fall back to whatever request the org has open now.
	requestId?: string;
} | null;

function UsageCard({ detail }: { detail: OrgDetail }) {
	const usage = detail.usage;
	return (
		<section className={card}>
			<h2 className={cardTitle}>Usage &amp; seats</h2>
			{!usage ? (
				<p className="text-sm text-text-secondary">Usage unavailable</p>
			) : (
				<>
					<dl className="grid grid-cols-2 gap-3 text-sm">
						{LIMIT_KEYS.map((k) => (
							<div key={k}>
								<dt className="text-xs text-text-tertiary">
									{LIMIT_LABELS[k]}
								</dt>
								<dd>
									<UsageCell
										meter={
											usage
												.meters[
												k
											]
										}
										isMeter={k.endsWith(
											"_month"
										)}
									/>
								</dd>
							</div>
						))}
					</dl>
					<p className="text-xs text-text-tertiary">
						Since {shortDate(`${usage.period_start}T00:00:00`)}
					</p>
				</>
			)}
		</section>
	);
}

function HistoryTab({ orgId }: { orgId: string }) {
	const history = useOrgHistory(orgId);
	return (
		<HistoryList
			rows={history.data}
			isLoading={history.isLoading}
			error={history.error}
			eventLabels={ORG_EVENT_LABELS}
		/>
	);
}

function BackLink() {
	return (
		<Link to="/platform/orgs" className="text-sm text-primary hover:underline">
			← Organizations
		</Link>
	);
}

export interface OrgDetailPrefill {
	change: StaffChange;
	title: string;
	requestId?: string;
}

export default function OrgDetailPage() {
	const { orgId = "" } = useParams();
	const [params, setParams] = useSearchParams();
	const tab = params.get("tab") === "history" ? "history" : "subscription";
	const org = useOrg(orgId);
	const tiers = useTiers();
	const [dialog, setDialog] = useState<DialogState>(null);
	const toast = useToast();
	const [changed, setChanged] = useState<Set<string>>(new Set());
	const [resetKey, setResetKey] = useState(0);
	const location = useLocation();
	const navigate = useNavigate();
	const prefillDone = useRef(false);
	const openRequest = useOpenRequestFor(orgId);
	const [resolving, setResolving] = useState<RequestResolution | null>(null);
	const prefill = (location.state as { prefill?: OrgDetailPrefill } | null)?.prefill;
	const updatedAt = org.data?.entitlement?.updated_at;
	const draft = usePlanDraft(orgId, org.data);
	const { seed } = draft;
	const guard = useUnsavedGuard(!!draft.state);
	// The requests page's Approve opens this page with the requested change; open it once and
	// drop the router state so reload or back does not reopen it.
	useEffect(() => {
		if (!prefill || !updatedAt || prefillDone.current) return;
		prefillDone.current = true;
		if (isDraftable(prefill.change))
			seed(prefill.change, { requestId: prefill.requestId });
		else
			setDialog({
				change: prefill.change,
				title: prefill.title,
				expectedUpdatedAt: updatedAt,
				requestId: prefill.requestId,
			});
		navigate(
			{ pathname: location.pathname, search: location.search },
			{ replace: true, state: null }
		);
	}, [prefill, updatedAt, seed, navigate, location.pathname, location.search]);

	if (org.isLoading)
		return (
			<div className="space-y-3">
				<BackLink />
				{[0, 1, 2].map((i) => (
					<div
						key={i}
						className="h-24 animate-pulse rounded-lg bg-surface-inset"
					/>
				))}
			</div>
		);
	if (org.error) {
		const notFound = (org.error as AxiosError).response?.status === 404;
		return (
			<div className="space-y-3">
				<BackLink />
				{notFound ? (
					<p className="text-sm text-text-secondary">
						Organization not found
					</p>
				) : (
					<FormErrorBanner message={platformError(org.error)} />
				)}
			</div>
		);
	}
	const detail = org.data!;
	const e = detail.entitlement;
	const tierList = tiers.data ?? [];
	const open = (d: DialogTarget) =>
		setDialog(d && { ...d, expectedUpdatedAt: e?.updated_at });
	const moduleLabel = (k: string) => detail.catalog.find((m) => m.key === k)?.label ?? k;
	const onApplied = (p: StaffChangePreview) => {
		if (!dialog) return;
		const deferred = dialog.change.kind === "plan" && !!detail.breakdown?.trialTier;
		toast.success(appliedMessage(dialog.title, p.diff, moduleLabel, deferred));
		setChanged(changedKeys(p.diff, dialog.change));
		setResetKey((k) => k + 1);
	};
	const onDraftSaved = (r: Extract<SaveResult, { status: "saved" }>) => {
		const diff = r.preview?.diff ?? NO_DIFF;
		const deferred =
			r.changes.some((c) => c.kind === "plan") && !!detail.breakdown?.trialTier;
		toast.success(appliedMessage("Plan saved", diff, moduleLabel, deferred));
		setChanged(new Set(r.changes.flatMap((c) => [...changedKeys(diff, c)])));
		setResetKey((k) => k + 1);
	};
	const chips: ReactNode[] = [
		<span key="tier" className={chip}>
			{detail.breakdown
				? `${detail.breakdown.baseTier.label} v${detail.breakdown.baseTier.version}`
				: (versionLabel(tierList, e?.plan_version_id ?? null) ??
					`${detail.resolved.planKey} v${detail.resolved.planVersion}`)}
		</span>,
	];
	if (detail.resolved.trialActive && e?.trial_ends_at)
		chips.push(
			<span key="trial" className={chip}>
				Trial: {versionLabel(tierList, e.trial_plan_version_id) ?? "tier"}{" "}
				until {shortDate(e.trial_ends_at)}
			</span>
		);
	if (e)
		chips.push(
			<span key="tpl" className={chip}>
				{e.template_key}
			</span>
		);

	return (
		<div className="space-y-4">
			<BackLink />
			<div className="space-y-2">
				<h1 className="text-lg font-semibold text-text-primary">
					{detail.org.name}
				</h1>
				<div className="flex flex-wrap gap-2">{chips}</div>
			</div>
			{openRequest && tiers.data && (
				<RequestBanner
					request={openRequest}
					tiers={tiers.data}
					onApply={(d) =>
						isDraftable(d.change)
							? draft.seed(d.change, {
									requestId: openRequest.id,
								})
							: setDialog({
									...d,
									expectedUpdatedAt:
										e?.updated_at,
									requestId: openRequest.id,
								})
					}
					onResolve={setResolving}
				/>
			)}
			<SegmentedToggle<"subscription" | "history">
				ariaLabel="Organization view"
				value={tab}
				options={[
					{ id: "subscription", label: "Subscription" },
					{ id: "history", label: "History" },
				]}
				onChange={(id) =>
					setParams(id === "history" ? { tab: "history" } : {}, {
						replace: true,
					})
				}
			/>
			{tiers.error && <FormErrorBanner message={platformError(tiers.error)} />}
			{tab === "history" ? (
				<HistoryTab orgId={orgId} />
			) : !e ? (
				<FormErrorBanner message="This organization has no entitlement row." />
			) : (
				<div className="grid items-start gap-4 lg:grid-cols-2">
					<PlanCard
						key={`plan-${resetKey}`}
						detail={detail}
						tiers={tierList}
						open={open}
						changed={changed}
						draft={draft}
						draftBar={
							draft.state && (
								<PlanDraftBar
									draft={draft}
									detail={detail}
									tiers={tierList}
									requestId={
										draft.state
											.requestId ??
										openRequest?.id
									}
									onSaved={onDraftSaved}
								/>
							)
						}
					/>
					<div className="flex flex-col gap-4">
						<LimitsCard
							key={`limits-${resetKey}`}
							detail={detail}
							open={open}
							changed={changed}
						/>
						<UsageCard detail={detail} />
					</div>
				</div>
			)}
			<ChangeDialog
				orgId={orgId}
				change={dialog?.change ?? null}
				title={dialog?.title ?? ""}
				expectedUpdatedAt={dialog?.expectedUpdatedAt}
				requestId={dialog?.requestId ?? openRequest?.id}
				markApprovedByDefault={!!dialog?.requestId}
				onApplied={onApplied}
				onClose={() => setDialog(null)}
			/>
			<ConfirmDialog
				open={!!guard.pending}
				title="Discard unsaved changes?"
				body="The tier and module changes on the Plan card are not saved yet."
				confirmLabel="Discard and leave"
				tone="destructive"
				onConfirm={guard.leave}
				onCancel={guard.stay}
			/>
			<ResolveRequestDialog
				key={`${openRequest?.id}-${resolving}`}
				request={openRequest}
				mode={resolving}
				onClose={() => setResolving(null)}
			/>
		</div>
	);
}
