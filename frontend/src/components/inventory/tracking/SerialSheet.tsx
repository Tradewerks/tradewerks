import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, PackageX } from "lucide-react";
import Drawer from "../../ui/Drawer";
import { Field, SheetError } from "./sheetShared";
import { formatDate } from "./sheetFormat";
import { movementReasonLabel as reasonLabel } from "../../../lib/movementReasons";
import { useSerialHistoryQuery, useSerialsQuery } from "../../../hooks/useTracking";
import i18n from "../../../i18n";
import type { SerialHistoryEvent, SerialUnitStatus } from "../../../types/tracking";

export type SerialSheetTarget =
	| { mode: "serial"; serialId: string }
	| { mode: "item"; itemId: string; itemName: string };

export interface SerialSheetProps {
	target: SerialSheetTarget | null;
	onClose: () => void;
	/** Units on this vehicle are the tech's own; anything else is read-only. */
	vehicleId: string;
	/** Fired when the tech taps Report Lost. The page closes the sheet and opens AdjustStockModal. */
	onReportLost: (args: { serialUnitId: string; inventoryItemId: string }) => void;
}

const STATUS_TONE: Record<SerialUnitStatus, string> = {
	in_warehouse: "bg-surface-raised text-text-secondary border-border",
	on_vehicle: "bg-primary/15 text-primary-text border-primary/30",
	consumed: "bg-surface-raised text-text-muted border-border",
	lost: "bg-error-bg text-error-text border-error-border",
	returned: "bg-warning-bg text-warning-text border-warning-border",
};

function locationLabel(event: SerialHistoryEvent): string {
	if (event.to_vehicle) return event.to_vehicle.name;
	if (event.to_location_type === "warehouse") return i18n.t("stock.warehouse");
	if (event.to_location_type === "adjustment") return i18n.t("tracking.removed");
	if (event.to_location_type === "visit") return event.visit?.job.job_number ?? i18n.t("tracking.jobVisit");
	return event.to_location_type;
}

function SerialDetail({
	serialId,
	vehicleId,
	onReportLost,
}: {
	serialId: string;
	vehicleId: string;
	onReportLost: SerialSheetProps["onReportLost"];
}) {
	const { t } = useTranslation();
	const { data, isLoading, isError } = useSerialHistoryQuery(serialId);

	if (isLoading) {
		return <p className="px-5 py-6 text-sm text-text-muted">{t("tracking.loadingUnit")}</p>;
	}

	if (isError || !data) {
		return <SheetError message={t("tracking.unitFailed")} />;
	}

	const { serial, timeline } = data;

	// The backend rejects any transition off a unit that isn't on_vehicle
	// (inventoryController.ts:1881) and a tech only adjusts their own truck — so
	// anything else gets a read-only sheet rather than a button that 403s.
	const canReportLost =
		serial.status === "on_vehicle" && serial.current_vehicle?.id === vehicleId;

	return (
		<div className="flex flex-col">
			<div className="px-5 pt-4 pb-3">
				<div className="flex items-start justify-between gap-3">
					<p className="font-mono text-base font-semibold text-text-primary break-all">
						{serial.serial_number}
					</p>
					<span
						className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONE[serial.status]}`}
					>
						{t(`serialStatus.${serial.status}`)}
					</span>
				</div>
				<p className="mt-1 text-sm text-text-secondary truncate">
					{serial.item.name}
				</p>
			</div>

			<div className="px-5">
				<Field label={t("tracking.received")} value={formatDate(serial.received_at)} />
				{serial.current_vehicle && (
					<Field
						label={t("tracking.location")}
						value={serial.current_vehicle.name}
					/>
				)}
				{serial.batch && (
					<Field label={t("tracking.lot")} value={serial.batch.batch_number} />
				)}
				{serial.consumed_at && (
					<Field
						label={t("tracking.used")}
						value={formatDate(serial.consumed_at)}
					/>
				)}
				{serial.client && (
					<Field label={t("tracking.client")} value={serial.client.name} />
				)}
			</div>

			{serial.note && (
				<div className="px-5 pt-3">
					<p className="text-xs text-text-muted mb-1">{t("tracking.note")}</p>
					<p className="rounded-lg bg-surface-raised px-3 py-2 text-sm text-text-secondary">
						{serial.note}
					</p>
				</div>
			)}

			<div className="px-5 pt-4 pb-2">
				<p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
					{t("tracking.history")}
				</p>
			</div>
			<div className="px-5 pb-4">
				{timeline.length === 0 ? (
					<p className="text-xs text-text-muted">
						{t("tracking.noMovements")}
					</p>
				) : (
					<ol className="space-y-2.5">
						{timeline.map((event) => (
							<li key={event.id} className="flex gap-3">
								<div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
								<div className="min-w-0 flex-1">
									<p className="text-sm text-text-primary">
										{reasonLabel(
											event.reason
										)}
									</p>
									<p className="text-xs text-text-muted truncate">
										{locationLabel(
											event
										)}{" "}
										·{" "}
										{formatDate(
											event.created_at
										)}
									</p>
									{event.note && (
										<p className="mt-0.5 text-xs text-text-secondary">
											{event.note}
										</p>
									)}
								</div>
							</li>
						))}
					</ol>
				)}
			</div>

			{canReportLost && (
				<div className="sticky bottom-0 border-t border-border-subtle bg-surface px-5 py-3">
					<button
						type="button"
						onClick={() =>
							onReportLost({
								serialUnitId: serial.id,
								inventoryItemId: serial.item.id,
							})
						}
						className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-error-border bg-error-bg text-sm font-semibold text-error-text transition-colors hover:bg-error-bg/70"
					>
						<PackageX size={16} />
						{t("tracking.reportLost")}
					</button>
				</div>
			)}
		</div>
	);
}

function SerialList({
	itemId,
	vehicleId,
	onPick,
}: {
	itemId: string;
	vehicleId: string;
	onPick: (serialId: string) => void;
}) {
	const { t } = useTranslation();
	const { data, isLoading, isError } = useSerialsQuery(itemId, { status: "on_vehicle", vehicleId });
	const units = data?.serials ?? [];

	if (isLoading) {
		return <p className="px-5 py-6 text-sm text-text-muted">{t("unitPicker.loading")}</p>;
	}

	if (isError) {
		return <SheetError message={t("tracking.unitsFailed")} />;
	}

	if (units.length === 0) {
		return <p className="px-5 py-6 text-sm text-text-muted">{t("tracking.noUnits")}</p>;
	}

	return (
		<div className="px-5 py-3">
			<p className="mb-2 text-xs text-text-muted">
				{t("tracking.unitsOnVehicle", { count: units.length })}
			</p>
			<div className="space-y-1.5">
				{units.map((unit) => (
					<button
						key={unit.id}
						type="button"
						onClick={() => onPick(unit.id)}
						className="flex h-11 w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 text-left transition-colors hover:bg-surface-raised"
					>
						<span className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary">
							{unit.serial_number}
						</span>
						<ChevronRight size={16} className="shrink-0 text-text-muted" />
					</button>
				))}
			</div>
		</div>
	);
}

export default function SerialSheet({
	target,
	onClose,
	vehicleId,
	onReportLost,
}: SerialSheetProps) {
	// Drilling from list mode into a unit is local state — the page only ever
	// hands us the entry point.
	const { t } = useTranslation();
	const [drilledSerialId, setDrilledSerialId] = useState<string | null>(null);

	// target flips to null on close, but Drawer keeps children mounted for its
	// 200ms exit transition — so reset on target change rather than relying on
	// unmount, or a reopen would land on the last unit viewed. This is React's
	// documented "adjusting state when a prop changes" pattern; it re-renders
	// before paint and beats an effect round-trip.
	const [lastTargetKey, setLastTargetKey] = useState<string | null>(null);
	const targetKey = target ? (target.mode === "serial" ? target.serialId : target.itemId) : null;
	if (targetKey !== lastTargetKey) {
		setLastTargetKey(targetKey);
		if (drilledSerialId !== null) setDrilledSerialId(null);
	}

	const activeSerialId = target?.mode === "serial" ? target.serialId : drilledSerialId;
	const showBack = target?.mode === "item" && drilledSerialId !== null;
	const title = activeSerialId ? t("tracking.unit") : target?.mode === "item" ? target.itemName : "";

	return (
		<Drawer isOpen={!!target} onClose={onClose} title={title} side="center">
			{showBack && (
				<button
					type="button"
					onClick={() => setDrilledSerialId(null)}
					className="flex h-11 w-full items-center gap-1.5 border-b border-border-subtle px-5 text-left text-sm text-text-secondary transition-colors hover:text-text-primary"
				>
					<ChevronLeft size={16} />
					{t("tracking.backToUnits")}
				</button>
			)}

			{activeSerialId ? (
				<SerialDetail serialId={activeSerialId} vehicleId={vehicleId} onReportLost={onReportLost} />
			) : target?.mode === "item" ? (
				<SerialList itemId={target.itemId} vehicleId={vehicleId} onPick={setDrilledSerialId} />
			) : null}
		</Drawer>
	);
}
