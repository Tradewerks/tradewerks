import { useState } from "react";
import { Check, QrCode } from "lucide-react";
import { useLabelQueueStore } from "../../../stores/labelQueueStore";
import type { LabelQueueItem } from "../../../stores/labelQueueStore";

// AddToLabelQueueButton (components/inventory/labels/) only accepts a full
// InventoryItem and hardcodes kind: "item". Serials/batches already have
// their own `code` from receiving, so this talks to labelQueueStore directly
// instead, matching the same icon-button visual language.
export function QueueLabelButton({
	id,
	code,
	kind,
	primaryLabel,
	secondaryLabel,
}: {
	id: string;
	code: string;
	kind: LabelQueueItem["kind"];
	primaryLabel: string;
	secondaryLabel?: string;
}) {
	const add = useLabelQueueStore((s) => s.add);
	const [added, setAdded] = useState(false);

	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				add({ id, code, kind, primaryLabel, secondaryLabel });
				setAdded(true);
				window.setTimeout(() => setAdded(false), 1200);
			}}
			title={added ? "Added to label queue" : "Add to label queue"}
			className="p-2 -my-1 rounded text-text-faint hover:text-primary hover:bg-primary/10 transition-colors"
		>
			{added ? (
				<Check size={14} className="text-success-text" />
			) : (
				<QrCode size={14} />
			)}
		</button>
	);
}
