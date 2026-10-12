import { Link } from "react-router-dom";
import { MapPin, Clock, Briefcase } from "lucide-react";
import type { Client } from "../../types/clients";

interface ClientCardProps {
	client: Client;
	to: string;
	viewMode?: "card" | "list";
}

function capitalizeWords(str: string) {
	return str
		.toLowerCase()
		.replace(/(^|[\s-/])([a-z])/g, (_, separator, letter) => {
			return separator + letter.toUpperCase();
		});

}

function formatLastActivity(raw: unknown) {
	if (!raw) return "No recent activity";

	let d: Date;

	if (raw instanceof Date) {
		d = raw;
	} else if (typeof raw === "string") {
		d = new Date(raw);
	} else {
		d = new Date(String(raw));
	}

	if (isNaN(d.getTime())) {
		return "No recent activity";
	}

	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export default function ClientCard({ client, to, viewMode = "card" }: ClientCardProps) {
	const displayName = capitalizeWords(client.name);
	const lastActivityText = formatLastActivity(client.last_activity);
	const jobsCount = client.jobs?.length ?? 0;
	const address = client.address || "No address provided";

	if (viewMode === "list") {
		return (
			<Link
				to={to}
				className="flex items-center gap-4 w-full px-4 py-3 bg-base border border-border-card rounded-lg hover:border-border-strong transition-colors duration-150 ease-out"
			>
				<div
					className={`shrink-0 w-2 h-2 rounded-full ${
						client.is_active ? "bg-success-text" : "bg-neutral"
					}`}
				/>

				<h3
					className="text-text-primary font-semibold text-sm min-w-0 max-w-[40%] truncate"
					title={displayName}
				>
					{displayName}
				</h3>

				<div className="flex items-center gap-1.5 text-sm text-text-tertiary flex-1 min-w-0">
					<MapPin size={14} className="shrink-0" />
					<span className="truncate" title={address}>
						{address}
					</span>
				</div>

				<div className="shrink-0 flex items-center gap-4 text-xs text-text-muted">
					<span>Jobs: <span className="text-text-secondary">{jobsCount}</span></span>
					<div className="flex items-center gap-1">
						<Clock size={12} />
						<span>{lastActivityText}</span>
					</div>
				</div>
			</Link>
		);
	}

	// No fixed size: the page's grid sets the width and stretches a row to its
	// tallest card, so a long name or address wraps instead of being cut to a
	// few words, and the footer's mt-auto keeps every card's rule on one line.
	return (
		<Link
			to={to}
			className="group flex min-w-0 flex-col rounded-lg border border-border-card bg-base p-4 transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-raised focus-visible:border-primary"
		>
			<div className="flex items-start justify-between gap-3">
				<h3 className="min-w-0 break-words line-clamp-2 text-base font-semibold text-text-primary group-hover:text-primary-text transition-colors duration-150 ease-out">
					{displayName}
				</h3>
				<span
					className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
						client.is_active
							? "bg-success/10 text-success-text border-success/20"
							: "bg-surface text-text-tertiary border-border"
					}`}
				>
					{client.is_active ? "Active" : "Inactive"}
				</span>
			</div>

			<div className="mt-2 flex items-start gap-2 pb-3 text-sm text-text-tertiary">
				<MapPin size={15} className="mt-0.5 shrink-0" />
				<span className="min-w-0 break-words line-clamp-2" title={address}>
					{address}
				</span>
			</div>

			<div className="mt-auto flex items-center justify-between gap-3 border-t border-border-subtle pt-3 text-xs text-text-tertiary">
				<span className="inline-flex items-center gap-1.5">
					<Briefcase size={13} className="opacity-70" />
					<span>
						<span className="tabular-nums text-text-secondary">{jobsCount}</span>{" "}
						{jobsCount === 1 ? "job" : "jobs"}
					</span>
				</span>
				<span className="inline-flex min-w-0 items-center gap-1.5">
					<Clock size={13} className="shrink-0 opacity-70" />
					<span className="truncate">{lastActivityText}</span>
				</span>
			</div>
		</Link>
	);
}
