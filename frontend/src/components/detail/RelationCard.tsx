import { cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Link2Off } from "lucide-react";

interface RelationCardProps {
	/** "Related Quote", "Job Container" — the uppercase eyebrow naming the slot. */
	eyebrow: string;
	/** Travels with `title`. Either missing renders the empty state. */
	to?: string;
	emptyLabel: string;
	icon?: ReactNode;
	title?: string;
	subtitle?: string;
	/** The date row, or any secondary line. */
	meta?: ReactNode;
	/** Amount, status pill, or both stacked. */
	trailing?: ReactNode;
	/**
	 * An action offered from inside the empty box — "Convert to Job" and the
	 * like. Dropped once the slot is filled, where the card is a link and a
	 * nested button would be both invalid and unreachable by keyboard.
	 */
	emptyAction?: ReactNode;
}

/**
 * One link to a related entity, or the dashed box saying there isn't one.
 *
 * A Link, not a button that navigates, so middle-click, cmd-click and "copy
 * link address" work.
 */
export default function RelationCard({
	eyebrow,
	to,
	emptyLabel,
	icon,
	title,
	subtitle,
	meta,
	trailing,
	emptyAction,
}: RelationCardProps) {
	const eyebrowEl = (
		<p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
			{eyebrow}
		</p>
	);

	// Size and shrink behaviour are fixed here rather than at each call site,
	// which is how the four hand-written copies drifted apart.
	const iconEl =
		icon && isValidElement(icon)
			? cloneElement(icon as ReactElement<{ size?: number; className?: string }>, {
					size: 14,
					className: "flex-shrink-0 text-primary-text",
				})
			: icon;

	if (!to || !title) {
		return (
			<div className="rounded-lg border border-dashed border-border-subtle bg-base/40 p-4">
				{eyebrowEl}
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2 text-sm text-text-faint">
						<Link2Off size={14} className="flex-shrink-0" />
						<span>{emptyLabel}</span>
					</div>
					{emptyAction && <div className="flex-shrink-0">{emptyAction}</div>}
				</div>
			</div>
		);
	}

	return (
		<Link
			to={to}
			className="group block rounded-lg border border-border bg-base p-4 transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface"
		>
			{eyebrowEl}
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<h4 className="mb-1 flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary transition-colors duration-150 ease-out group-hover:text-primary-text">
						{iconEl}
						<span className="truncate">{title}</span>
					</h4>
					{subtitle && (
						<p className="mb-2 truncate text-xs text-text-tertiary">
							{subtitle}
						</p>
					)}
					{meta && (
						<div className="flex items-center gap-2 text-xs text-text-muted">
							{meta}
						</div>
					)}
				</div>
				{trailing && (
					<div className="flex flex-shrink-0 flex-col items-end gap-2">
						{trailing}
					</div>
				)}
			</div>
		</Link>
	);
}
