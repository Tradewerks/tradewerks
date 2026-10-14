import { AlertTriangle, Plus } from "lucide-react";
import { money } from "../../fieldPurchases/fieldPurchaseFormat";
import type { FieldPurchaseRefundParentLine } from "../../../types/fieldPurchases";
import { blankLine, type LineDraft } from "./lineDrafts";
import { draftKey, returnableParts, type ReturnablePart } from "./refundParts";

/**
 * The parts this refund can give back, one tap each. Typing a returned part by
 * hand left it unlinked, and an unlinked refund line moves no stock on approval —
 * picking it from the purchase is what carries the link across.
 */
export default function RefundPartPicker({
	parentLines,
	lines,
	allocationKey,
	onChange,
}: {
	parentLines: FieldPurchaseRefundParentLine[];
	lines: LineDraft[];
	allocationKey: string;
	onChange: (next: LineDraft[]) => void;
}) {
	const parts = returnableParts(parentLines, lines).filter((p) => p.left > 0);
	if (parts.length === 0) return null;

	const add = (part: ReturnablePart) => {
		const at = lines.findIndex((d) => draftKey(d) === part.key);
		if (at >= 0) {
			const d = lines[at]!;
			onChange(
				lines.map((x, i) =>
					i === at
						? {
								...d,
								quantity: String(
									(Number(d.quantity) || 0) +
										1
								),
								acknowledged: false,
							}
						: x
				)
			);
			return;
		}
		onChange([
			...lines,
			{
				...blankLine(allocationKey),
				description: part.description,
				unit_price: part.unit_price,
				inventory_item_id: part.inventory_item_id ?? "",
				disposition: "",
				// Offered from the purchase, not read off the credit slip — the
				// store may credit a different price, so it still gets checked.
				acknowledged: false,
			},
		]);
	};

	return (
		<div className="mb-3">
			<p className="mb-1.5 text-xs text-text-muted">
				From your original purchase
			</p>
			<ul className="space-y-1.5">
				{parts.map((p) => (
					<li key={p.key}>
						<button
							type="button"
							onClick={() => add(p)}
							aria-label={`Add ${p.description} to this refund`}
							className="flex min-h-11 w-full items-center gap-2 rounded-md border border-border bg-surface px-3 text-left transition-colors duration-150 ease-out hover:bg-surface-raised"
						>
							<Plus
								aria-hidden
								size={14}
								className="flex-shrink-0 text-text-muted"
							/>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm text-text-primary">
									{p.description}
								</span>
								<span className="block truncate text-xs text-text-muted">
									{money(
										Number(p.unit_price)
									)}{" "}
									each · {p.left} left to
									return
								</span>
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * What approving this line does to stock — the one fact about a refund line the
 * technician cannot see anywhere else. Replaces the purchase sheet's stock picker,
 * whose answer a refund ignores: stock always leaves where the purchase put it.
 */
export function RefundLineStock({
	draft,
	parentLines,
}: {
	draft: LineDraft;
	parentLines: FieldPurchaseRefundParentLine[];
}) {
	const part = returnableParts(parentLines, []).find((p) => p.key === draftKey(draft));
	const linked = !!draft.inventory_item_id && !!part;
	const over = linked && (Number(draft.quantity) || 0) > part.left;
	return (
		<p
			className={`mt-2 inline-flex items-start gap-1 text-xs ${over ? "text-warning-text" : "text-text-muted"}`}
		>
			{over && (
				<AlertTriangle
					aria-hidden
					size={12}
					className="mt-0.5 flex-shrink-0"
				/>
			)}
			{over
				? `Only ${part.left} of these can come back off stock`
				: linked && part.from
					? `Comes off ${part.from} when approved`
					: "No stock comes off — this is not a stocked part from the purchase"}
		</p>
	);
}
