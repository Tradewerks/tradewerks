import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

/**
 * The technician sheet's select: 44px for a gloved thumb, with its own chevron.
 * The native arrow sits inside the select's padding, so at px-2 it was jammed
 * against the border; drawn here it gets the same inset as the text.
 */
export default function TechSelect({
	className = "",
	surface = "base",
	...props
}: SelectHTMLAttributes<HTMLSelectElement> & { surface?: "base" | "surface" }) {
	return (
		<div className="relative">
			<select
				{...props}
				className={`h-11 w-full appearance-none rounded-md border border-border ${surface === "base" ? "bg-base" : "bg-surface"} pl-3 pr-9 text-sm text-text-primary transition-colors duration-150 ease-out hover:enabled:border-border-strong focus:border-primary focus:outline-none disabled:opacity-60 [&>option]:bg-base [&>option]:text-text-primary ${className}`}
			/>
			<ChevronDown
				aria-hidden
				size={16}
				className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted ${props.disabled ? "opacity-60" : ""}`}
			/>
		</div>
	);
}
