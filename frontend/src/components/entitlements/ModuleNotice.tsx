import type { ReactNode } from "react";
import { Info } from "lucide-react";

export default function ModuleNotice({
	title,
	action,
	children,
	className = "mb-4",
}: {
	title: ReactNode;
	action?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div
			role="status"
			className={`${className} rounded-md border border-border bg-surface-inset px-4 py-3`}
		>
			<div className="flex items-start gap-2.5">
				<Info
					size={14}
					aria-hidden
					className="mt-0.5 shrink-0 text-text-tertiary"
				/>
				<div className="min-w-0 flex-1 text-sm text-text-primary">
					{title}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			{children ? <div className="mt-2 pl-6">{children}</div> : null}
		</div>
	);
}
