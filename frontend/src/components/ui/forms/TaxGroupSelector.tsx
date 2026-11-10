import { Lock } from "lucide-react";
import type { TaxGroup } from "../../../types/tax";
import { parseTaxChoice } from "../../../lib/taxEditorMode";
import TaxChoiceOptions from "./TaxChoiceOptions";

interface TaxGroupSelectorProps {
	value: string | null;
	taxable: boolean;
	taxGroups: TaxGroup[];
	clientExempt: boolean;
	onChange: (tax_group_id: string | null, taxable: boolean) => void;
	disabled?: boolean;
	autoMode?: boolean;
	keptRateLabel?: string | null;
}

const TaxGroupSelector = ({
	value,
	taxable,
	taxGroups,
	clientExempt,
	onChange,
	disabled = false,
	autoMode = false,
	keptRateLabel = null,
}: TaxGroupSelectorProps) => {
	if (clientExempt) {
		return (
			<div className="flex items-center gap-1.5 h-[34px] px-2.5 rounded border border-border bg-base text-text-muted text-sm select-none">
				<Lock size={12} className="flex-shrink-0 text-text-faint" />
				<span>Tax Exempt</span>
			</div>
		);
	}

	// Manual mode saves a taxable ungrouped line at the org default group (e.g. after picking a
	// taxable item onto a "No Tax" line), so show that group rather than "No Tax".
	const manualFallback = taxGroups.find((g) => g.is_default && g.is_active)?.id ?? "none";
	const ungroupedValue = autoMode || keptRateLabel ? "auto" : manualFallback;
	const selectValue = !taxable ? "none" : value || ungroupedValue;

	const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) =>
		onChange(...parseTaxChoice(e.target.value));

	return (
		<div
			className={[
				"relative w-full h-[34px] border border-border rounded bg-base overflow-hidden transition-colors",
				!disabled && "hover:border-border-strong focus-within:border-primary",
				disabled && "opacity-60",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<select
				value={selectValue}
				onChange={handleChange}
				disabled={disabled}
				className={`appearance-none w-full h-full px-2.5 pr-7 bg-base text-sm border-0 outline-none focus:ring-0 disabled:cursor-not-allowed [&>option]:bg-base [&>option]:text-text-primary
					${selectValue === "none" ? "text-text-muted" : "text-text-primary"}`}
			>
				<TaxChoiceOptions
					taxGroups={taxGroups}
					autoMode={autoMode}
					keptRateLabel={keptRateLabel}
				/>
			</select>
			{/* Arrow matches Dropdown component */}
			<svg
				className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary"
				width="10"
				height="6"
				viewBox="0 0 10 6"
				fill="none"
				aria-hidden="true"
			>
				<path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</div>
	);
};

export default TaxGroupSelector;
export type { TaxGroupSelectorProps };
