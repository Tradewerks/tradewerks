import { useState } from "react";
import { isAxiosError } from "axios";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	getDisablePreview,
	updateModuleChoices,
	type DisablePreview,
} from "../../api/entitlements";
import { ENTITLEMENTS_QUERY_KEY, useEntitlements } from "../../hooks/useEntitlements";
import { usePermission } from "../../hooks/usePermission";
import { groupModules, relationsOf, type Module } from "../../lib/moduleGroups";
import ModuleRow from "./subscription/ModuleRow";
import SubscriptionRail from "./subscription/SubscriptionRail";

// The backend message already names the dependency or the unfinished work.
const messageOf = (err: unknown): string =>
	(isAxiosError(err) && err.response?.data?.error?.message) ||
	"Could not update modules. Please try again.";

const LAYOUT = "grid items-start gap-6 pt-2 pb-8 lg:grid-cols-[minmax(0,720px)_300px]";

export default function EntitlementsSection() {
	const { data, isLoading } = useEntitlements();
	const canManage = usePermission("manage_organization");
	const queryClient = useQueryClient();
	const [panel, setPanel] = useState<{ key: string; preview: DisablePreview } | null>(null);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);

	const mutation = useMutation({
		mutationFn: updateModuleChoices,
		onSuccess: (next) => {
			queryClient.setQueryData(ENTITLEMENTS_QUERY_KEY, next);
			setPanel(null);
		},
		onError: (err, choices) =>
			setRowError({ key: Object.keys(choices)[0], message: messageOf(err) }),
		onSettled: () => setBusyKey(null),
	});

	if (!data) {
		if (isLoading) {
			return (
				<div className={LAYOUT} aria-busy="true">
					<div className="space-y-3">
						{[0, 1, 2].map((i) => (
							<div key={i} className="h-12 animate-pulse rounded-md bg-surface motion-reduce:animate-none" />
						))}
					</div>
					<div className="h-40 animate-pulse rounded-xl bg-surface motion-reduce:animate-none" />
				</div>
			);
		}
		return (
			<div className="pt-2 pb-8">
				<p role="alert" className="text-sm text-text-secondary">
					Subscription details could not be loaded.
				</p>
				<button
					type="button"
					onClick={() => queryClient.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY })}
					className="mt-2 text-sm font-medium text-primary hover:underline"
				>
					Try again
				</button>
			</div>
		);
	}

	// A module switched off from elsewhere while its panel is open must not keep
	// offering "Turn off", nor bring the old preview back if it is switched on again.
	if (panel && data.modules.find((m) => m.key === panel.key)?.state !== "on") setPanel(null);

	const toggle = async (module: Module) => {
		// One change at a time; other rows stay live and simply ignore the click.
		if (busyKey) return;
		setRowError(null);
		if (panel?.key === module.key && module.state === "on") return setPanel(null);
		setPanel(null);
		setBusyKey(module.key);
		if (module.state !== "on") {
			mutation.mutate({ [module.key]: true });
			return;
		}
		try {
			setPanel({ key: module.key, preview: await getDisablePreview(module.key) });
		} catch (err) {
			setRowError({ key: module.key, message: messageOf(err) });
		} finally {
			setBusyKey(null);
		}
	};

	const confirmOff = (module: Module) => {
		if (busyKey) return;
		setRowError(null);
		setBusyKey(module.key);
		mutation.mutate({ [module.key]: false });
	};

	return (
		<div className={LAYOUT}>
			<div className="min-w-0">
				{!canManage && (
					<p className="mb-4 text-xs text-text-tertiary">
						Only people who can manage the organization can change modules.
					</p>
				)}
				{groupModules(data.modules).map((group, index) => (
					<section
						key={group.label}
						aria-labelledby={`module-group-${index}`}
						className="mb-6 last:mb-0"
					>
						<h3
							id={`module-group-${index}`}
							className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary"
						>
							{group.label}
						</h3>
						<ul className="divide-y divide-border-subtle border-y border-border-subtle">
							{group.modules.map((m) => (
								<ModuleRow
									key={m.key}
									module={m}
									relations={relationsOf(m, data.modules)}
									canManage={canManage}
									busy={busyKey === m.key}
									preview={panel?.key === m.key && m.state === "on" ? panel.preview : null}
									error={rowError?.key === m.key ? rowError.message : null}
									onToggle={() => toggle(m)}
									onConfirmOff={() => confirmOff(m)}
									onClosePanel={() => setPanel(null)}
								/>
							))}
						</ul>
					</section>
				))}
			</div>
			<SubscriptionRail data={data} />
		</div>
	);
}
