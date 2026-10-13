import { Headset, ShieldUser, Wrench, type LucideIcon } from "lucide-react";
import { USER_KIND_LABELS, type UserKind } from "./userKind";

// Wrench and ShieldUser match the Technicians and Admin sidebar items.
const ICONS: Record<UserKind, LucideIcon> = {
	technician: Wrench,
	dispatcher: Headset,
	admin: ShieldUser,
};

export default function UserTypeChip({ kind }: { kind: UserKind }) {
	const Icon = ICONS[kind];
	return (
		<span className="inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs font-medium text-text-secondary">
			<Icon size={12} aria-hidden className="shrink-0 text-text-tertiary" />
			{USER_KIND_LABELS[kind]}
		</span>
	);
}
