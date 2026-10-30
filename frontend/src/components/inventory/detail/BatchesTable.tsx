import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Boxes, Plus, Truck } from "lucide-react";
import { useBatchesQuery } from "../../../hooks/useTracking";
import SearchBar from "../../ui/SearchBar";
import PageControls from "../../ui/PageControls";
import EmptyState from "../../ui/EmptyState";
import LoadSvg from "../../../assets/icons/loading.svg?react";
import type { BatchListRow } from "../../../types/tracking";
import { formatDate } from "../../../util/util";
import { QueueLabelButton } from "./trackingTableShared";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";

// Renders inside a Card in InventoryItemDetailPage's Tracking tab (no page
// chrome of its own).

const BATCH_GRID = "grid-cols-[140px_160px_120px_90px_1fr_48px]";

function daysUntil(dateStr: string): number {
	return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

function expiryTone(expiresAt: string | null): "none" | "soon" | "expired" {
	if (!expiresAt) return "none";
	const days = daysUntil(expiresAt);
	if (days < 0) return "expired";
	if (days <= 30) return "soon";
	return "none";
}

export default function BatchesTable({
	itemId,
	itemName,
	onReceive,
	readOnly = false,
}: {
	itemId: string;
	itemName: string;
	onReceive?: () => void;
	/**
	 * Archive mode — batch tracking is off for this item but its lots survive as
	 * history. Rows, search, and drill-through stay; the label-queue button goes,
	 * since printing a lot label for a drained, no-longer-tracked lot is noise.
	 */
	readOnly?: boolean;
}) {
	const navigate = useNavigate();
	const [searchInput, setSearchInput] = useState("");
	const search = useDebouncedValue(searchInput, 300);
	const { data, isLoading } = useBatchesQuery(itemId, { search: search || undefined });
	const batches: BatchListRow[] = data?.batches ?? [];
	const hasSearch = search.trim().length > 0;

	return (
		<div>
			<PageControls
				className="mb-3"
				left={
					<SearchBar
						value={searchInput}
						onChange={setSearchInput}
						placeholder="Search batch # or code..."
					/>
				}
				right={
					<span className="text-sm text-text-tertiary whitespace-nowrap">
						<span className="font-semibold text-text-primary tabular-nums">
							{batches.length}
						</span>{" "}
						batch{batches.length !== 1 ? "es" : ""}
					</span>
				}
			/>

			{isLoading && (
				<div className="flex justify-center py-16">
					<LoadSvg className="w-8 h-8" />
				</div>
			)}

			{!isLoading && batches.length === 0 && (
				<EmptyState
					icon={<Boxes size={28} />}
					title={
						hasSearch
							? "No batches match your search"
							: "No batches yet"
					}
					description={
						hasSearch
							? "Try a different batch number or code."
							: readOnly
								? "Batch tracking is turned off for this item and no lots were recorded."
								: "Receive stock to add batches/lots for this item."
					}
					action={
						!hasSearch && onReceive
							? {
									label: "Receive Stock",
									onClick: onReceive,
									icon: <Plus size={14} />,
								}
							: undefined
					}
				/>
			)}

			{batches.length > 0 && (
				<div className="border border-border-subtle bg-base rounded-lg overflow-hidden">
					<div className="overflow-x-auto">
						<div className="min-w-[720px]">
							<div
								className={`grid ${BATCH_GRID} items-center px-4 py-2.5 border-b border-border-subtle bg-base`}
							>
								{[
									"Batch #",
									"Code",
									"Expiry",
									"Warehouse Qty",
									"Vehicles",
									"",
								].map((h) => (
									<div
										key={h}
										className="text-xs font-bold text-text-tertiary"
									>
										{h}
									</div>
								))}
							</div>
							{batches.map((batch) => {
								const tone = expiryTone(batch.expires_at);
								return (
									<div
										key={batch.id}
										role="button"
										tabIndex={0}
										onClick={() =>
											navigate(
												`/dispatch/inventory/batches/${batch.id}`
											)
										}
										onKeyDown={(e) => {
											if (
												e.key !== "Enter" &&
												e.key !== " "
											)
												return;
											e.preventDefault();
											navigate(
												`/dispatch/inventory/batches/${batch.id}`
											);
										}}
										aria-label={`View batch ${batch.batch_number}`}
										className={`grid ${BATCH_GRID} items-center px-4 py-2.5 border-t border-border-subtle hover:bg-surface transition-colors cursor-pointer`}
									>
										<div className="min-w-0 pr-2">
											<div className="text-sm font-medium text-text-primary break-all">
												{batch.batch_number}
											</div>
											{batch.recalled_at && (
												<span className="inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-error/20 text-error-text border border-error/30">
													RECALLED
												</span>
											)}
										</div>
										<div className="text-xs font-mono text-text-muted break-all pr-2">
											{batch.code}
										</div>
										<div className="text-xs pr-2">
											{batch.expires_at ? (
												<div
													className={
														tone ===
														"expired"
															? "text-orange-text font-semibold"
															: tone ===
																  "soon"
																? "text-warning-text font-semibold"
																: "text-text-secondary"
													}
												>
													<div>
														{formatDate(
															batch.expires_at
														)}
													</div>
													{tone ===
														"expired" && (
														<div className="text-[10px]">
															Expired
														</div>
													)}
													{tone ===
														"soon" && (
														<div className="text-[10px]">
															Expires
															in{" "}
															{daysUntil(
																batch.expires_at
															)}
															d
														</div>
													)}
												</div>
											) : (
												<span className="text-text-faint">
													—
												</span>
											)}
										</div>
										<div className="text-sm font-semibold tabular-nums text-text-primary">
											{Number(
												batch.qty_in_warehouse
											)}
										</div>
										<div className="min-w-0 pr-2">
											{batch.vehicles.length ===
											0 ? (
												<span className="text-text-faint text-xs">
													—
												</span>
											) : (
												<div className="flex flex-wrap gap-1">
													{batch.vehicles.map(
														(v) => (
															<span
																key={
																	v.vehicle_id
																}
																className="inline-flex items-center gap-1 text-[11px] bg-surface-raised border border-border-subtle rounded-full px-2 py-0.5 text-text-secondary"
															>
																<Truck
																	size={
																		10
																	}
																/>
																{
																	v.vehicle_name
																}{" "}
																·{" "}
																{Number(
																	v.qty_on_hand
																)}
															</span>
														)
													)}
												</div>
											)}
										</div>
										<div className="flex justify-end">
											{!readOnly && (
												<QueueLabelButton
													id={batch.id}
													code={batch.code}
													kind="batch"
													primaryLabel={
														itemName
													}
													secondaryLabel={
														batch.batch_number
													}
												/>
											)}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
