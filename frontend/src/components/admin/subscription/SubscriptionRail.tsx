import { Check, Lock } from "lucide-react";
import type { EntitlementsData } from "../../../lib/permissionAccess";
import { stateLabel } from "../../../lib/moduleGroups";
import UsageMeters from "./UsageMeters";

const sectionLabel = "text-[11px] font-medium uppercase tracking-wide text-text-tertiary";

// The API returns the key only; a label is a backend follow-up (spec §9, B2).
const nameOf = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

export default function SubscriptionRail({ data }: { data: EntitlementsData }) {
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
						{nameOf(data.plan.key)}
					</p>
					{data.plan.trialActive && (
						<span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
							Trial
						</span>
					)}
				</div>
				<p className="mt-2 text-xs text-text-muted">
					Changes to your subscription are handled by TradeWerks
					support.
				</p>
			</div>
			{data.usage && <UsageMeters usage={data.usage} />}
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
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</aside>
	);
}
