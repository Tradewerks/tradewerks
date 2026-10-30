import type { ReactNode } from "react";

interface CardProps {
	title?: string;
	headerAction?: ReactNode;
	children: ReactNode;
	className?: string;
	scrollable?: boolean;
	/* Opt-in: hold the scrollbar thumb transparent until the card is hovered.
	   Off by default so the existing cards keep the scrollbar they have today. */
	quietScroll?: boolean;
	/* Drops the body padding for content that runs edge to edge under the header
	   divider (row lists with their own dividers and gutters). */
	flush?: boolean;
	/* Keeps the header on one line: the title truncates instead of wrapping. */
	noWrap?: boolean;
}

export default function Card({ title, headerAction, children, className = "", scrollable = false, quietScroll = false, flush = false, noWrap = false }: CardProps) {
	return (
		<div
			className={`bg-base border border-border-subtle rounded-xl overflow-hidden flex flex-col ${className}`}
		>
			{title && (
				/* Wraps rather than nowrap because a card is no longer always
				   full width: the invoice Payments card sits in a ~285px rail,
				   where its title plus Record and Refund need exactly the row it
				   has and touched with no gutter between them. Inert wherever the
				   row has slack — every other card header measured the same
				   height before and after. */
				/* 57px whether the row holds a bare title or an h-7 action
				   (ui/headerActions): py-3.5 + 28px + the 1px divider, the same
				   height a title-only p-4 header always had. A row only grows when
				   it wraps, so side-by-side cards keep their dividers on one line. */
				<div className={`flex ${noWrap ? "flex-nowrap" : "flex-wrap"} items-center justify-between gap-x-3 gap-y-2 min-h-[57px] px-4 py-3.5 border-b border-border-subtle`}>
					<h3 className={`font-semibold text-text-primary${noWrap ? " truncate min-w-0" : ""}`}>{title}</h3>
					{headerAction && <div className={noWrap ? "shrink-0 whitespace-nowrap" : undefined}>{headerAction}</div>}
				</div>
			)}
			<div className={`${flush ? "" : "p-4 "}flex-1 flex flex-col min-h-0${scrollable ? " widget-scroll" : ""}${scrollable && quietScroll ? " scrollbar-on-hover" : ""}`}>{children}</div>
		</div>
	);
}
