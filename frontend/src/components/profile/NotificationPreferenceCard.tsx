import Card from "../ui/Card";
import { useDispatcherByIdQuery, useUpdateDispatcherMutation } from "../../hooks/useDispatchers";
import { useAuthStore } from "../../auth/authStore";
import {
	DISPATCHER_NOTIFICATION_GROUPS,
	DISPATCHER_NOTIFICATION_OPTIONS,
	type DispatcherNotificationType,
} from "../../types/notifications";
import ToggleSwitch from "../ui/ToggleSwitch";
import { ChevronDown } from "lucide-react";

export default function NotificationPreferenceCard() {
	const { user } = useAuthStore();
	const { data: dispatcher } = useDispatcherByIdQuery(user?.userId);
	const updateDispatcher = useUpdateDispatcherMutation();
	const muted = dispatcher?.muted_notification_types ?? [];

	const toggle = (type: DispatcherNotificationType) => {
		if (!user?.userId) return;
		const next = muted.includes(type) ? muted.filter((t) => t !== type) : [...muted, type];
		updateDispatcher.mutate({ id: user.userId, data: { muted_notification_types: next } });
	};

	return (
		<Card title="Notification Preferences">
			{DISPATCHER_NOTIFICATION_GROUPS.map((group) => {
				const options = DISPATCHER_NOTIFICATION_OPTIONS.filter(
					(o) => o.group === group && user?.permissions.includes(o.permission),
				);
				if (options.length === 0) return null;
				const onCount = options.filter((o) => !muted.includes(o.type)).length;
				return (
					<details key={group} className="group border-b border-border-subtle last:border-b-0">
						<summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-2 py-3 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
							<span className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">
								{group}
							</span>
							<span className="flex items-center gap-2 text-xs text-text-muted">
								{onCount} of {options.length} on
								<ChevronDown
									size={16}
									className="transition-transform duration-200 group-open:rotate-180"
								/>
							</span>
						</summary>
						<div className="pb-2">
							{options.map(({ type, label, description }) => (
								<div
									key={type}
									className="flex items-center justify-between gap-4 px-2 py-3 border-b border-border-subtle last:border-b-0"
								>
									<div className="min-w-0">
										<p className="text-sm font-medium text-text-primary">{label}</p>
										<p className="text-xs text-text-muted">{description}</p>
									</div>
									<ToggleSwitch
										checked={!muted.includes(type)}
										onChange={() => toggle(type)}
										disabled={updateDispatcher.isPending}
										ariaLabel={label}
									/>
								</div>
							))}
						</div>
					</details>
				);
			})}
		</Card>
	);
}
