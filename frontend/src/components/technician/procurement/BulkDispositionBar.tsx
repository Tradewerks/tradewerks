import { useId } from "react";
import { DISPOSITION_LABELS, type FieldPurchaseDisposition } from "../../../types/fieldPurchases";
import { dispositionSentence } from "../../fieldPurchases/dispositionSummary";
import { isNegativeLine, type LineDraft, type SheetDisposition } from "./lineDrafts";

const SEGMENT =
	"min-h-11 min-w-0 flex-1 truncate px-2 text-sm font-medium transition-colors duration-150 ease-out disabled:opacity-60";
const ON = "bg-primary text-on-primary";
const OFF = "bg-base text-text-secondary hover:bg-surface";

/** Two or more answers side by side, one tap each — gloved, at a counter. */
function Segmented<T extends string>({
	labelledBy,
	options,
	value,
	disabled,
	onPick,
}: {
	labelledBy: string;
	options: { value: T; label: string }[];
	value: T;
	disabled?: boolean;
	onPick: (v: T) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-labelledby={labelledBy}
			className="flex overflow-hidden rounded-md border border-border"
		>
			{options.map((o, i) => (
				<button
					key={o.value || "none"}
					type="button"
					role="radio"
					aria-checked={o.value === value}
					disabled={disabled}
					onClick={() => onPick(o.value)}
					className={`${SEGMENT} ${i > 0 ? "border-l border-border" : ""} ${o.value === value ? ON : OFF}`}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

/**
 * The receipt's stock & billing answer, asked once for every line. Lines follow it
 * unless they were set on their own, and the ones that were are counted here so
 * the exceptions are never invisible behind the bulk answer.
 */
export default function BulkDispositionBar({
	value,
	lines,
	myVehicle,
	editable,
	onChange,
	onMatchAll,
}: {
	value: SheetDisposition;
	lines: LineDraft[];
	myVehicle?: { id: string; name: string } | null;
	editable: boolean;
	onChange: (next: SheetDisposition) => void;
	/** Lets every pinned line go back to following the sheet. */
	onMatchAll: () => void;
}) {
	const id = useId();

	if (!editable) {
		const sentence = dispositionSentence(
			lines.map((l) => ({
				disposition: l.disposition || null,
				vehicleName: l.disposition_vehicle_id
					? l.disposition_vehicle_id === myVehicle?.id
						? myVehicle.name
						: "your truck"
					: null,
			}))
		);
		return sentence ? (
			<p className="mb-3 text-xs text-text-secondary">
				<span className="text-text-muted">Stock &amp; billing · </span>
				{sentence}
			</p>
		) : null;
	}

	const pinned = lines.filter((l) => l.dispositionPinned).length;
	// Following lines the stock answer passes by. Not pinned: nobody chose it for
	// them, the server simply will not take a discount onto a shelf.
	const exempt =
		value.disposition === "receive"
			? lines.filter((l) => !l.dispositionPinned && isNegativeLine(l)).length
			: 0;

	const pickDisposition = (d: FieldPurchaseDisposition) =>
		onChange({
			disposition: d,
			vehicleId:
				d === "receive"
					? value.disposition === "receive"
						? value.vehicleId
						: (myVehicle?.id ?? "")
					: "",
		});

	return (
		<div className="mb-3 rounded-lg border border-border bg-surface p-2.5">
			<p id={`${id}-what`} className="mb-1.5 text-xs text-text-muted">
				Stock &amp; billing · all items
			</p>
			<Segmented
				labelledBy={`${id}-what`}
				value={value.disposition}
				onPick={pickDisposition}
				// The job first: it is the ordinary answer.
				options={(["non_stock", "receive"] as const).map((k) => ({
					value: k,
					label: DISPOSITION_LABELS[k],
				}))}
			/>

			{value.disposition === "receive" && (
				<div className="mt-2">
					<p id={`${id}-dest`} className="mb-1 text-xs text-text-muted">
						Goes onto
					</p>
					<Segmented
						labelledBy={`${id}-dest`}
						value={value.vehicleId}
						onPick={(vehicleId) => onChange({ ...value, vehicleId })}
						options={[
							{ value: "", label: "Warehouse" },
							...(myVehicle
								? [{ value: myVehicle.id, label: myVehicle.name }]
								: []),
						]}
					/>
					{!myVehicle && (
						<p className="mt-1 text-xs text-text-muted">
							No truck assigned — ask dispatch to sign you onto one to
							stock it.
						</p>
					)}
				</div>
			)}

			{(pinned > 0 || exempt > 0) && (
				<div
					role="status"
					className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted"
				>
					{pinned > 0 && (
						<>
							<span>
								{pinned} item{pinned === 1 ? "" : "s"} set
								separately
							</span>
							<span aria-hidden>·</span>
							<button
								type="button"
								onClick={onMatchAll}
								className="inline-flex min-h-9 items-center font-medium text-primary underline-offset-2 hover:underline"
							>
								Make all match
							</button>
						</>
					)}
					{pinned > 0 && exempt > 0 && <span aria-hidden>·</span>}
					{exempt > 0 && (
						<span>
							{exempt} discount{exempt === 1 ? " stays" : "s stay"} on
							the job
						</span>
					)}
				</div>
			)}
		</div>
	);
}
