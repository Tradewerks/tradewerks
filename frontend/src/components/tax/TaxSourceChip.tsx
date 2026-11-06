import { isAddressTaxSource, type TaxSource } from "../../types/tax";

type Tone = "primary" | "neutral" | "warning";

// eslint-disable-next-line react-refresh/only-export-components
export const TAX_SOURCE_LABEL: Record<TaxSource, { label: string; tone: Tone; title: string }> = {
	provider: {
		label: "Auto address rate",
		tone: "primary",
		title: "Rate looked up from the service address",
	},
	manual_override: {
		label: "Tax group",
		tone: "neutral",
		title: "A tax group chosen on a line or for the client",
	},
	cached_stale: {
		label: "Last known rate",
		tone: "warning",
		title: "The address lookup failed; using the last rate found for this address",
	},
	org_default: {
		label: "Default group",
		tone: "neutral",
		title: "The organization's default tax group",
	},
	legacy: {
		label: "Organization rate",
		tone: "neutral",
		title: "The organization's flat tax rate",
	},
	qb_ast: {
		label: "QuickBooks",
		tone: "neutral",
		title: "Calculated by QuickBooks",
	},
};

const TONE_CLASS: Record<Tone, string> = {
	primary: "border-primary-border bg-primary-bg text-primary-text",
	warning: "border-warning-border bg-warning-bg text-warning-text",
	neutral: "border-border-strong/50 bg-surface-raised/60 text-text-secondary",
};

/** Per-line tag for a taxable, ungrouped line on an address-sourced document. */
export function AutoLineTaxTag() {
	return (
		<span
			title="Taxed at the service address rate"
			className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${TONE_CLASS.primary}`}
		>
			Auto address rate
		</span>
	);
}

export function TaxSourceChip({
	source,
	kept = false,
}: {
	source: TaxSource | null | undefined;
	kept?: boolean;
}) {
	const entry = source ? TAX_SOURCE_LABEL[source] : undefined;
	if (!entry) return null;
	const { tone } = entry;
	const keptChip = kept && isAddressTaxSource(source);
	const label = keptChip ? "Address rate (from auto mode)" : entry.label;
	const title = keptChip
		? "Taxed at the address rate found while automatic tax was on"
		: entry.title;
	return (
		<span
			title={title}
			className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${TONE_CLASS[tone]}`}
		>
			{label}
		</span>
	);
}
