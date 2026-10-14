import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Lock } from "lucide-react";
import type { EntitlementsData } from "../../../lib/permissionAccess";
import { stateLabel } from "../../../lib/moduleGroups";
import UsageMeters from "./UsageMeters";
import RequestChangeDialog from "./RequestChangeDialog";
import RequestStatus from "./RequestStatus";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { useUpgradeRequests, useWithdrawUpgradeRequest } from "../../../hooks/useUpgradeRequests";
import { requestErrorMessage } from "../../../lib/upgradeRequests";
import { shortDateIn, trialEndsInDays } from "../../../lib/trialDays";
import { useAuthStore } from "../../../auth/authStore";
import { FALLBACK_TIMEZONE } from "../../../util/util";

const sectionLabel = "text-[11px] font-medium uppercase tracking-wide text-text-tertiary";

function trialLine(endsAt: string, timeZone: string) {
	const days = trialEndsInDays(endsAt);
	const date = shortDateIn(endsAt, timeZone);
	return `Trial ends ${date} · ${days} ${days === 1 ? "day" : "days"} left`;
}

// A cached entitlements snapshot can predate `plan.label`.
const SEAT_NOTES: Record<string, string> = {
	dispatchers: "We need more dispatcher seats.",
	technicians: "We need more technician seats.",
};

const nameOf = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

export default function SubscriptionRail({
	data,
	canManage,
}: {
	data: EntitlementsData;
	canManage: boolean;
}) {
	const tz = useAuthStore((s) => s.user?.orgTimezone) ?? FALLBACK_TIMEZONE;
	const requests = useUpgradeRequests(canManage);
	const withdraw = useWithdrawUpgradeRequest();
	const hasOpenRequest = (requests.data ?? []).some((r) => r.status === "open");
	const [dialog, setDialog] = useState<{ modules: string[]; note: string } | null>(null);
	const [withdrawId, setWithdrawId] = useState<string | null>(null);
	const [params, setParams] = useSearchParams();
	const openDialog = (modules: string[], note: string) => setDialog({ modules, note });
	const locked = data.modules
		.filter((m) => m.kind === "plan_gated" && m.state === "not_in_plan")
		.map((m) => ({ key: m.key, label: m.label }));
	const seatAsk = params.get("request");
	useEffect(() => {
		if (!seatAsk || (canManage && !requests.isSuccess)) return;
		const seatNote = SEAT_NOTES[seatAsk];
		if (canManage && !hasOpenRequest && seatNote) setDialog({ modules: [], note: seatNote });
		const next = new URLSearchParams(params);
		next.delete("request");
		setParams(next, { replace: true });
	}, [canManage, seatAsk, requests.isSuccess, hasOpenRequest, params, setParams]);
	const excludedLast = (state: string) => Number(state === "not_in_plan");
	const features = data.modules
		.filter((m) => m.kind === "plan_gated")
		.sort((a, b) => excludedLast(a.state) - excludedLast(b.state));

	return (
		<aside
			aria-label="Subscription"
			className="rounded-xl border border-border-subtle bg-base lg:sticky lg:top-4"
		>
			<div className="p-4">
				<p className={sectionLabel}>Subscription</p>
				<div className="mt-1 flex flex-wrap items-center gap-2">
					<p className="break-words text-lg font-semibold text-text-primary">
						{data.plan.label ?? nameOf(data.plan.key)}
					</p>
					{data.plan.trialActive && (
						<span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
							Trial
						</span>
					)}
				</div>
				{data.setup?.trial && (
					<p className="mt-1 text-xs text-text-secondary">
						{trialLine(data.setup.trial.endsAt, tz)}
					</p>
				)}
				{canManage ? (
					<div className="mt-3 space-y-2">
						<RequestStatus
							requests={requests.data ?? []}
							withdrawing={withdraw.isPending}
							onWithdraw={setWithdrawId}
						/>
						{!hasOpenRequest && (
							<button
								type="button"
								onClick={() => openDialog([], "")}
								className="h-8 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-surface-inset"
							>
								Request a change
							</button>
						)}
					</div>
				) : (
					<p className="mt-2 text-xs text-text-muted">
						Changes to your subscription are handled by
						TradeWerks support.
					</p>
				)}
			</div>
			{data.usage && <UsageMeters usage={data.usage} modules={data.modules} />}
			{features.length > 0 && (
				<div className="border-t border-border-subtle p-4">
					<h3 className={sectionLabel}>Subscription features</h3>
					<ul className="mt-2 space-y-3">
						{features.map((m) => {
							const included = m.state === "on";
							const Icon = included ? Check : Lock;
							return (
								<li
									key={m.key}
									className="flex items-start gap-2"
								>
									<Icon
										size={14}
										aria-hidden
										className={`mt-0.5 shrink-0 ${
											included
												? "text-text-secondary"
												: "text-text-tertiary"
										}`}
									/>
									<div className="min-w-0">
										<span
											className={`block text-sm font-medium ${
												included
													? "text-text-primary"
													: "text-text-secondary"
											}`}
										>
											{m.label}
										</span>
										<span className="block text-xs text-text-muted">
											{
												m.description
											}
										</span>
										<span
											className={
												included
													? "sr-only"
													: "mt-0.5 block text-xs text-text-tertiary"
											}
										>
											{stateLabel(
												m
											)}
										</span>
										{!included &&
											canManage &&
											!hasOpenRequest && (
												<button
													type="button"
													onClick={() =>
														openDialog(
															[
																m.key,
															],
															""
														)
													}
													className="mt-0.5 text-xs font-medium text-primary hover:underline"
												>
													Request
												</button>
											)}
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
			<RequestChangeDialog
				open={!!dialog}
				onClose={() => setDialog(null)}
				lockedModules={locked}
				initialModules={dialog?.modules}
				initialNote={dialog?.note}
			/>
			<ConfirmDialog
				open={!!withdrawId}
				title="Withdraw your request?"
				body={
					<p className="text-sm text-text-secondary">
						TradeWerks will no longer act on it. You can send a
						new one afterwards.
					</p>
				}
				confirmLabel="Withdraw"
				tone="destructive"
				pending={withdraw.isPending}
				error={
					withdraw.error
						? requestErrorMessage(
								withdraw.error,
								"Could not withdraw the request. Please try again."
							)
						: null
				}
				onConfirm={() =>
					withdraw.mutate(withdrawId!, {
						onSuccess: () => setWithdrawId(null),
					})
				}
				onCancel={() => {
					withdraw.reset();
					setWithdrawId(null);
				}}
			/>
		</aside>
	);
}
