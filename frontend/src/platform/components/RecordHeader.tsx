import type { ReactNode } from "react";

export default function RecordHeader({
	title,
	subtitle,
	badges,
	meta,
	actions,
}: {
	title: string;
	subtitle?: ReactNode;
	badges?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
			<div className="min-w-0">
				<h1 className="text-2xl font-semibold text-text-primary">
					{title}
					{subtitle && (
						<span className="ml-2 text-sm font-normal text-text-tertiary">
							{subtitle}
						</span>
					)}
				</h1>
				{badges && <div className="mt-1.5 flex flex-wrap gap-2">{badges}</div>}
				{meta && <div className="mt-1 text-xs text-text-tertiary">{meta}</div>}
			</div>
			{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
