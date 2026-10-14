import type { ReactNode } from "react";

export interface DetailTabDef<T extends string> {
	id: T;
	label: string;
	/** Something on this tab is happening right now, e.g. a tech en route. */
	live?: boolean;
}

interface DetailTabsProps<T extends string> {
	tabs: readonly DetailTabDef<T>[];
	activeTab: T;
	onSelect: (tab: T) => void;
	/** Names the strip for a screen reader, e.g. "Quote sections". */
	label: string;
	/**
	 * Optional lifecycle read-out fused to the top of the strip — "where in the
	 * run" and "which view" are one question. Omitted renders the bare strip.
	 */
	progress?: ReactNode;
}

/**
 * The bordered strip that sits flush beneath the header, so the two read as one
 * unit rather than two floating cards.
 *
 * Roving tabindex per the WAI-ARIA tabs pattern: only the selected tab is in
 * the tab order, Left/Right/Home/End move between them. Panels stay with the
 * caller — each page's `aria-labelledby="tab-<id>"` wrapper pairs with the
 * `tab-<id>` ids minted here.
 */
export default function DetailTabs<T extends string>({
	tabs,
	activeTab,
	onSelect,
	label,
	progress,
}: DetailTabsProps<T>) {
	const strip = (
		<div role="tablist" aria-label={label} className="flex border-b border-border">
			{tabs.map((tab, i) => (
				<button
					key={tab.id}
					id={`tab-${tab.id}`}
					type="button"
					role="tab"
					aria-selected={activeTab === tab.id}
					aria-controls={`tabpanel-${tab.id}`}
					tabIndex={activeTab === tab.id ? 0 : -1}
					onClick={() => onSelect(tab.id)}
					onKeyDown={(e) => {
						const last = tabs.length - 1;
						let nextIndex: number | null = null;
						if (e.key === "ArrowRight")
							nextIndex = i === last ? 0 : i + 1;
						else if (e.key === "ArrowLeft")
							nextIndex = i === 0 ? last : i - 1;
						else if (e.key === "Home") nextIndex = 0;
						else if (e.key === "End") nextIndex = last;
						if (nextIndex === null) return;
						e.preventDefault();
						const next = tabs[nextIndex];
						onSelect(next.id);
						// Selection follows focus, so the newly selected tab
						// has to actually receive it.
						document.getElementById(`tab-${next.id}`)?.focus();
					}}
					// `text-primary-text`, not `text-primary`: the latter
					// isn't theme-swapped and lands at ~3.7:1 on the light
					// base. The underline keeps `border-primary` — a
					// UI-component border only owes 3:1.
					className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors duration-150 ease-out ${
						activeTab === tab.id
							? "border-primary text-primary-text"
							: "border-transparent text-text-muted hover:text-text-secondary"
					}`}
				>
					{tab.label}
					{tab.live && (
						<>
							{" "}
							<span
								aria-hidden="true"
								className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-success align-middle"
							/>
							<span className="sr-only">(live)</span>
						</>
					)}
				</button>
			))}
		</div>
	);

	if (!progress) return strip;

	return (
		<div className="flex flex-col gap-2">
			{progress}
			{strip}
		</div>
	);
}
