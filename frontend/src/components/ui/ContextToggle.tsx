import { Briefcase, Repeat } from "lucide-react";

export type JobsView = "jobs" | "templates";

interface ContextToggleProps {
	value: JobsView;
	onChange: (value: JobsView) => void;
}

export default function ContextToggle({ value, onChange }: ContextToggleProps) {
	return (
		<div className="flex items-center bg-surface-raised gap-px rounded-md overflow-hidden border border-border shrink-0" role="group" aria-label="View context" data-report-context>
			<button
				onClick={() => onChange("jobs")}
				aria-pressed={value === "jobs"}
				className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold cursor-pointer transition-colors ${
					value === "jobs"
						? "bg-primary-hover text-on-primary"
						: "bg-base text-text-tertiary hover:text-text-primary hover:bg-surface"
				}`}
			>
				<Briefcase size={14} />
				<span>Jobs</span>
			</button>
			<button
				onClick={() => onChange("templates")}
				aria-pressed={value === "templates"}
				className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold cursor-pointer transition-colors ${
					value === "templates"
						? "bg-reviewing text-on-primary"
						: "bg-base text-text-tertiary hover:text-text-primary hover:bg-surface"
				}`}
			>
				<Repeat size={14} />
				<span>Plans</span>
			</button>
		</div>
	);
}
