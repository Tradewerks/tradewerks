import { useId, useState } from "react";
import type { AddressTaxChoice, AddressTaxChoiceDetails, TaxGroup } from "../../types/tax";
import { formatDocRatePercent } from "../../lib/formatTax";
import { formatCurrency } from "../../util/util";

interface AddressTaxChoicePanelProps {
	docNoun: "quote" | "job" | "client";
	/** "La Crosse, WI" */
	rateLabel: string;
	rate: number;
	newAddress: string;
	/** null → no estimate shown (client case: it spans several drafts). */
	keepCents: number | null;
	defaultGroup: { id: string; name: string; rate: number } | null;
	defaultCents: number | null;
	taxGroups: TaxGroup[];
	value: AddressTaxChoice | null;
	/** null while "Pick a group…" is open with no group chosen yet: Save must stay disabled. */
	onChange: (c: AddressTaxChoice | null) => void;
	groupCents?: (groupId: string) => number | null;
	/** The drafts the answer applies to, listed by number. */
	documents?: AddressTaxChoiceDetails["documents"];
}

type Option = "keep" | "default" | "pick";

/**
 * Asked inline when the address of a document taxed at a kept address rate changes. Keeping is a
 * legitimate answer (a corrected typo, a next-door address), so this is a plain choice in neutral
 * tones, never a warning.
 */
export default function AddressTaxChoicePanel({
	docNoun,
	rateLabel,
	rate,
	newAddress,
	keepCents,
	defaultGroup,
	defaultCents,
	taxGroups,
	value,
	onChange,
	groupCents,
	documents,
}: AddressTaxChoicePanelProps) {
	const name = useId();
	const [picking, setPicking] = useState(false);
	const selected: Option | null =
		value === "keep"
			? "keep"
			: value === "default"
				? "default"
				: value != null || picking
					? "pick"
					: null;
	const pickedId = value != null && typeof value === "object" ? value.group_id : "";
	const pct = formatDocRatePercent(rate);
	const subject =
		docNoun === "client" ? "This client's draft invoices were" : `This ${docNoun} was`;
	const question = `${subject} taxed at the ${rateLabel} address rate (${pct}). The address is now ${newAddress}. Which tax should ${docNoun === "client" ? "they" : "it"} use?`;
	const numbered = (documents ?? []).filter((d) => d.number);

	const choose = (opt: Option) => {
		setPicking(opt === "pick");
		if (opt === "pick") onChange(null);
		else onChange(opt);
	};

	const row = (
		opt: Option,
		label: string,
		hint: string | null,
		cents: number | null,
		extra?: React.ReactNode,
	) => (
		<label
			key={opt}
			className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors duration-150 ease-out focus-within:ring-1 focus-within:ring-primary-border ${
				selected === opt
					? "border-primary bg-primary-bg-subtle"
					: "border-border-subtle hover:bg-surface"
			}`}
		>
			<input
				type="radio"
				name={name}
				value={opt}
				checked={selected === opt}
				onChange={() => choose(opt)}
				className="mt-0.5 accent-(--color-primary)"
			/>
			<span className="min-w-0 flex-1">
				<span className="text-xs">
					<span className="font-medium text-text-primary">{label}</span>
					{hint && <> <span className="text-text-muted">{hint}</span></>}
				</span>
				{extra}
			</span>
			{cents != null && (
				<span className="flex-shrink-0 font-mono text-xs tabular-nums text-text-secondary">
					≈ {formatCurrency(cents / 100)}
				</span>
			)}
		</label>
	);

	return (
		<fieldset className="rounded-lg border border-border bg-base p-3">
			<legend className="sr-only">Tax after address change</legend>
			<p className="mb-2 text-xs text-text-secondary">{question}</p>
			{numbered.length > 0 && (
				<p className="mb-2 text-xs text-text-muted">
					Applies to {numbered.map((d) => d.number).join(", ")}
				</p>
			)}
			<div className="space-y-1.5">
				{row(
					"keep",
					`Keep ${rateLabel} rate (${pct})`,
					"— use when the new address is in the same tax area.",
					keepCents,
				)}
				{defaultGroup &&
					row(
						"default",
						`Use ${defaultGroup.name} (${formatDocRatePercent(defaultGroup.rate)})`,
						"— the default group.",
						defaultCents,
					)}
				{taxGroups.length > 0 &&
					row(
						"pick",
						"Pick a group…",
						null,
						pickedId && groupCents ? groupCents(pickedId) : null,
						selected === "pick" && (
							<select
								aria-label="Tax group"
								value={pickedId}
								onChange={(e) =>
									onChange(
										e.target.value ? { group_id: e.target.value } : null,
									)
								}
								className="mt-1.5 block w-full rounded border border-border bg-base px-2 py-1 text-xs text-text-primary focus:border-primary focus:outline-none"
							>
								<option value="">Choose a group</option>
								{taxGroups.map((g) => (
									<option key={g.id} value={g.id}>
										{g.name} ({formatDocRatePercent(g.combined_rate)})
									</option>
								))}
							</select>
						),
					)}
			</div>
		</fieldset>
	);
}
