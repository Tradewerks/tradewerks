import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ShieldOff, Undo2, WifiOff } from "lucide-react";
import { useFieldPurchaseQueue, useMyPurchaseAuthority } from "../../hooks/useFieldPurchases";
import AskForAccessButton from "../../components/technician/procurement/AskForAccessButton";
import AuthorityStrip from "../../components/technician/procurement/AuthorityStrip";
import RequestApprovalButton from "../../components/technician/procurement/RequestApprovalButton";
import StartPurchaseButton from "../../components/technician/procurement/StartPurchaseButton";
import { money } from "../../components/fieldPurchases/fieldPurchaseFormat";
import TechPage from "../../components/technician/TechPage";
import { refundStateLabel } from "../../components/technician/procurement/sheetCopy";
import { isPrePurchase, type FieldPurchase, type FieldPurchaseStatus } from "../../types/fieldPurchases";

/** One screenful of history, with more a tap away. */
const PAGE = 20;

/** The statuses where the purchase is waiting on the technician, not on dispatch. Text in `purchases.nudge`. */
const NUDGE = ["draft", "preauth_approved", "preauth_denied", "queried"] as const;
type NudgeStatus = (typeof NUDGE)[number];
const isNudge = (s: FieldPurchaseStatus): s is NudgeStatus => (NUDGE as readonly string[]).includes(s);

function statusTone(purchase: FieldPurchase) {
	switch (purchase.status) {
		case "approved":
			return "text-success";
		case "rejected":
		case "preauth_denied":
			return "text-error-text";
		case "queried":
			return "text-warning";
		default:
			return "text-text-secondary";
	}
}

/**
 * The technician's own purchases, and the two ways one starts. Those are a fork,
 * not a common case and an edge case: the choice is "record a field purchase"
 * against "request approval before buying", and the second is where their own
 * money is at stake. Both sit above
 * the history, which is an archive.
 */
export default function TechnicianPurchasesPage() {
	const { t } = useTranslation();
	const {
		data: authority,
		isLoading: authorityLoading,
		isError: authorityFailed,
	} = useMyPurchaseAuthority();
	// Capped rather than unbounded: a technician who has been buying for a year
	// should not wait on every receipt they have ever filed to see this week's.
	const [limit, setLimit] = useState(PAGE);
	const { data: page, isLoading, isError: listFailed } = useFieldPurchaseQueue({ limit });
	const purchases = page?.items ?? [];
	const [searchParams] = useSearchParams();

	const grant = authority?.grant ?? null;
	const authorized = !!grant?.is_active;

	// Arriving from a link that already knows the job opens the approval sheet on it.
	const preselected = searchParams.get("jobId");
	// Set when the technician came through the vehicle page's Adjust Stock
	// doorway, so a part bought to restock that truck defaults back onto it.
	const vehicleId = searchParams.get("vehicleId");

	// Scoped to the page that is loaded: a purchase still waiting on its
	// technician is a recent one, and a query per status would cost four round
	// trips to say so.
	const needsYou = purchases.filter((p) => isNudge(p.status));
	const rest = purchases.filter((p) => !isNudge(p.status));

	if (authorityLoading) {
		return <p className="p-4 text-sm text-text-muted">{t("common.loading")}</p>;
	}

	// Before the not-authorized branch: a failed request leaves `grant` null, which
	// is indistinguishable from a revoked one, and telling a technician they have no
	// authority when the network dropped sends them to dispatch over nothing.
	if (authorityFailed) {
		return (
			<TechPage className="flex items-start gap-3 rounded-xl border border-border bg-base p-4">
				<WifiOff aria-hidden size={18} className="mt-0.5 flex-shrink-0 text-warning-text" />
				<div>
					<h1 className="text-sm font-semibold text-text-primary">
						{t("purchases.limitsFailed")}
					</h1>
					<p className="mt-1 text-xs text-text-muted">{t("purchases.limitsFailedHint")}</p>
				</div>
			</TechPage>
		);
	}

	if (!authorized) {
		// No limits shown: a revoked grant still carries its old numbers, and
		// printing a ceiling that no longer applies is worse than printing none.
		return (
			<TechPage className="flex items-start gap-3 rounded-xl border border-border bg-base p-4">
				<ShieldOff aria-hidden size={18} className="mt-0.5 flex-shrink-0 text-text-muted" />
				<div>
					<h1 className="text-sm font-semibold text-text-primary">
						{t("purchase.notEnabled")}
					</h1>
					<p className="mt-1 text-xs text-text-muted">{t("purchases.enabledPerTech")}</p>
					<div className="mt-2">
						<AskForAccessButton />
					</div>
				</div>
			</TechPage>
		);
	}

	return (
		<TechPage className="space-y-4">
			<header>
				<h1 className="text-base font-semibold text-text-primary">{t("profile.field_purchases")}</h1>
				<p className="mt-1 text-xs text-text-muted">{t("purchases.intro")}</p>
				<div className="mt-2">
					<AuthorityStrip grant={grant} spent={authority!.spent} />
				</div>
			</header>

			<div className="space-y-2">
				<StartPurchaseButton
					job={null}
					vehicleId={vehicleId}
					label={t("visitDetail.recordPurchase")}
					hint={t("visitDetail.recordPurchaseHint")}
				/>
				<RequestApprovalButton preselectedJobId={preselected} autoOpen={!!preselected} />
			</div>

			{needsYou.length > 0 && (
				<section>
					<h2 className="mb-2 text-sm font-semibold text-text-primary">{t("purchases.needsYou")}</h2>
					<ul className="space-y-2">
						{needsYou.map((p) => (
							<PurchaseRow
								key={p.id}
								purchase={p}
								nudge={isNudge(p.status) ? t(`purchases.nudge.${p.status}`) : undefined}
							/>
						))}
					</ul>
				</section>
			)}

			<section>
				<h2 className="mb-2 text-sm font-semibold text-text-primary">{t("purchases.yourPurchases")}</h2>
				{isLoading ? (
					<p className="text-sm text-text-muted">{t("common.loading")}</p>
				) : listFailed ? (
					<p className="rounded-xl border border-border bg-base p-4 text-sm text-warning-text">
						{t("purchases.listFailed")}
					</p>
				) : rest.length === 0 ? (
					<p className="rounded-xl border border-border bg-base p-4 text-sm text-text-muted">
						{needsYou.length > 0 ? t("purchases.nothingElse") : t("purchases.nothingYet")}
					</p>
				) : (
					<ul className="space-y-2">
						{rest.map((p) => (
							<PurchaseRow key={p.id} purchase={p} />
						))}
					</ul>
				)}
				{page && page.total > purchases.length && (
					<button
						type="button"
						onClick={() => setLimit((n) => n + PAGE)}
						className="mt-2 inline-flex h-11 w-full items-center justify-center rounded-md border border-border bg-surface text-sm font-medium text-text-secondary hover:bg-surface-raised"
					>
						{t("purchases.showOlder", { count: page.total - purchases.length })}
					</button>
				)}
			</section>
		</TechPage>
	);
}

function PurchaseRow({ purchase, nudge }: { purchase: FieldPurchase; nudge?: string }) {
	const { t, i18n } = useTranslation();
	const isRefund = purchase.kind === "refund";
	return (
		<li>
			<Link
				to={`/technician/purchases/${purchase.id}`}
				className="block min-h-11 rounded-xl border border-border bg-base p-3 transition-colors hover:bg-surface"
			>
				<div className="flex items-baseline justify-between gap-2">
					<span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-text-primary">
						{/* A refund row is otherwise the purchase it reverses, twice. */}
						{isRefund && (
							<>
								<Undo2
									aria-hidden
									size={13}
									className="flex-shrink-0 text-text-muted"
								/>
								<span className="sr-only">{t("purchases.refundSr")}</span>
							</>
						)}
						<span className="truncate">
							{purchase.vendor_name || t("purchases.noVendor")}
						</span>
					</span>
					<span className="flex-shrink-0 text-sm tabular-nums text-text-primary">
						{/* Before the counter `total` holds the estimate, so an
						    unlabelled figure here claimed a price had been paid. */}
						{isPrePurchase(purchase.status) && (
							<>
								<span
									aria-hidden
									className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary"
								>
									{t("purchases.est")}
								</span>
								<span className="sr-only">{t("purchases.estimated")}</span>
							</>
						)}
						{isRefund ? "−" : ""}
						{money(purchase.total)}
					</span>
				</div>
				<div className="mt-1 flex items-center justify-between gap-2">
					<span className="flex min-w-0 items-center gap-1.5">
						<span className={`text-xs font-medium ${statusTone(purchase)}`}>
							{isRefund
								? refundStateLabel(purchase)
								: t(`status.fieldPurchase.${purchase.status}`)}
						</span>
						{/* Two trips to the same counter in a week look identical without it. */}
						{purchase.purchased_at && (
							<span className="truncate text-xs text-text-muted">
								· {new Date(purchase.purchased_at).toLocaleDateString(i18n.language)}
							</span>
						)}
					</span>
					{purchase.flags.length > 0 && (
						<span className="inline-flex flex-shrink-0 items-center gap-1 text-xs text-warning">
							<AlertTriangle aria-hidden size={11} /> {purchase.flags.length}
						</span>
					)}
				</div>
				{nudge && <p className="mt-1 text-xs text-text-secondary">{nudge}</p>}
			</Link>
		</li>
	);
}
