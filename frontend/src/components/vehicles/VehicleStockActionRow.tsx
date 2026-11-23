import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Barcode } from "lucide-react";
import type { RestockMode } from "../../api/org";

const PRIMARY =
	"flex-1 py-2 text-xs font-semibold rounded-lg bg-primary-hover hover:bg-primary text-on-primary transition-colors";
const OUTLINE =
	"flex-1 py-2 text-xs font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface transition-colors";
const TINTED =
	"flex-1 py-2 text-xs font-semibold rounded-lg bg-primary-hover/10 border border-primary-hover/30 text-primary-text hover:bg-primary-hover/20 transition-colors";

interface Props {
	restockMode: RestockMode | undefined;
	canStock: boolean;
	canAdjustStock: boolean;
	canFieldLoss: boolean;
	hasStockItems: boolean;
	onFill: () => void;
	onAdjust: () => void;
	onRequestRestock: () => void;
	onScan: () => void;
}

// restock_mode only reorders and restyles; every button here is gated by
// permissions alone. Adjust Stock covers loss/transfer/audit, not restocking,
// so it never moves behind the self-stocking disclosure.
export default function VehicleStockActionRow({
	restockMode,
	canStock,
	canAdjustStock,
	canFieldLoss,
	hasStockItems,
	onFill,
	onAdjust,
	onRequestRestock,
	onScan,
}: Props) {
	const { t } = useTranslation();
	// Short visible labels keep the row on one line at 390px; aria-label keeps the full wording
	const fillLabel = `↑ ${t("actionRow.fill")}`;
	const [showSelfStock, setShowSelfStock] = useState(false);
	const selfStockId = useId();
	const dispatchPrepared = restockMode === "dispatch_prepared";
	// Undefined while the org loads: render neither mode's Fill placement, so a
	// dispatch-prepared org never flashes the self-serve layout.
	const selfServe = restockMode === "tech_self_serve";

	const requestButton = hasStockItems && (
		<button
			type="button"
			onClick={onRequestRestock}
			aria-label={t("actionRow.requestRestock")}
			className={dispatchPrepared ? PRIMARY : TINTED}
		>
			{t("actionRow.restock")}
		</button>
	);

	return (
		<div className="px-4 py-2.5 border-b border-border-subtle space-y-2">
			<div className="flex gap-2 items-stretch">
				{canStock && selfServe && (
					<button type="button" onClick={onFill} aria-label={t("vehicle.fillToStandard")} className={PRIMARY}>
						{fillLabel}
					</button>
				)}
				{dispatchPrepared && requestButton}
				{canStock && canAdjustStock && (
					<button
						type="button"
						onClick={onAdjust}
						aria-label={t("adjust.stepTitle.type")}
						className={OUTLINE}
					>
						{t("actionRow.adjust")}
					</button>
				)}
				{!dispatchPrepared && requestButton}
				{canFieldLoss && (
					<button
						type="button"
						onClick={onScan}
						title={t("actionRow.scan")}
						aria-label={t("actionRow.scan")}
						className="flex-shrink-0 p-2 flex items-center justify-center rounded-lg border border-border text-text-secondary hover:bg-surface transition-colors"
					>
						<Barcode size={16} />
					</button>
				)}
			</div>
			{canStock && dispatchPrepared && (
				<>
					<button
						type="button"
						aria-expanded={showSelfStock}
						aria-controls={selfStockId}
						onClick={() => setShowSelfStock((v) => !v)}
						className="text-xs text-text-muted hover:text-text-secondary transition-colors"
					>
						{t(showSelfStock ? "actionRow.hideSelf" : "actionRow.showSelf")}
					</button>
					<div
						id={selfStockId}
						hidden={!showSelfStock}
						className="flex items-center gap-2"
					>
						{showSelfStock && (
							<button
								type="button"
								onClick={onFill}
								aria-label={t("vehicle.fillToStandard")}
								className={OUTLINE}
							>
								{fillLabel}
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
