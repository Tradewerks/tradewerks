import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import { Lock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { markModulesReviewed, updateModuleChoices } from "../../api/entitlements";
import { ENTITLEMENTS_QUERY_KEY, useEntitlements } from "../../hooks/useEntitlements";
import { useBusinessTypes } from "../../hooks/useBusinessTypes";
import { groupModules, SUBSCRIPTION_PATH } from "../../lib/moduleGroups";
import {
	draftChanges,
	initialDraft,
	toggleDraft,
	welcomeReturnPath,
	type Draft,
} from "../../lib/welcomeDraft";
import ToggleSwitch from "../../components/ui/ToggleSwitch";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";

export default function WelcomePage() {
	const { data } = useEntitlements();
	const types = useBusinessTypes();
	const navigate = useNavigate();
	const location = useLocation();
	const qc = useQueryClient();
	const [draft, setDraft] = useState<Draft | null>(null);
	const [note, setNote] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	if (!data)
		return (
			<div
				className="mx-auto mt-6 h-64 max-w-[720px] animate-pulse rounded-xl bg-surface motion-reduce:animate-none"
				aria-busy="true"
			/>
		);

	const current = draft ?? initialDraft(data.modules);
	const typeKey = data.setup?.templateKey ?? "general";
	const typeLabel = types.data?.find((t) => t.key === typeKey)?.label ?? typeKey;

	const flip = (key: string) => {
		const { next, also } = toggleDraft(data.modules, current, key);
		setDraft(next);
		setNote(also.length ? `${also.join(", ")} switched with it.` : "");
	};

	const finish = async (save: boolean) => {
		setBusy(true);
		setError("");
		try {
			const changes = draftChanges(data.modules, current);
			if (save && Object.keys(changes).length) await updateModuleChoices(changes);
			await markModulesReviewed();
			await qc.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY });
			navigate(welcomeReturnPath(location.state), { replace: true });
		} catch (err) {
			setError(
				(isAxiosError(err) && err.response?.data?.error?.message) ||
					"Could not save your modules. Try again.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mx-auto max-w-[720px] space-y-6">
			<div>
				<h1 className="text-xl font-semibold text-text-primary">
					Here's what's on for {typeLabel}
				</h1>
				<p className="mt-1 text-sm text-text-secondary">
					We switched these on for your kind of business. Change anything now, or later in
					Admin → Subscription.
				</p>
			</div>
			{error && <FormErrorBanner message={error} />}
			{note && (
				<p className="text-xs text-text-tertiary" aria-live="polite">
					{note}
				</p>
			)}
			{groupModules(data.modules).map((group, i) => (
				<section key={group.label} aria-labelledby={`welcome-group-${i}`}>
					<h2
						id={`welcome-group-${i}`}
						className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary"
					>
						{group.label}
					</h2>
					<ul className="divide-y divide-border-subtle border-y border-border-subtle">
						{group.modules.map((m) => (
							<li key={m.key} className="flex items-start justify-between gap-4 py-3">
								<div className="min-w-0">
									<span className="block text-sm font-medium text-text-primary">
										{m.label}
									</span>
									<span className="block text-xs text-text-muted">{m.description}</span>
								</div>
								{m.state === "not_in_plan" ? (
									<Link
										to={SUBSCRIPTION_PATH}
										className="flex shrink-0 items-center gap-1 text-xs text-text-tertiary hover:text-primary"
									>
										<Lock size={12} aria-hidden /> Request a change
									</Link>
								) : (
									<ToggleSwitch
										checked={!!current[m.key]}
										onChange={() => flip(m.key)}
										disabled={busy}
										ariaLabel={m.label}
									/>
								)}
							</li>
						))}
					</ul>
				</section>
			))}
			<div className="flex justify-end gap-2">
				<button
					type="button"
					disabled={busy}
					onClick={() => finish(false)}
					className="h-9 rounded-md border border-border px-4 text-sm text-text-primary hover:bg-surface-inset disabled:opacity-50"
				>
					Skip
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => finish(true)}
					className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
				>
					Looks good
				</button>
			</div>
		</div>
	);
}
