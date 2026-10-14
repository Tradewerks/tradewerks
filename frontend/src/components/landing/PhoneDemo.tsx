import type { ReactNode } from "react";
import { CardLabel } from "./primitives";
import { PAUSE_REASONS, STATUS_PILLS, useElapsed, type VisitDemo } from "./visitDemo";

const card = "rounded-xl border border-line bg-white";

function LineItem({ name, qty }: { name: string; qty: ReactNode }) {
	return (
		<div className="flex justify-between gap-2.5 text-[15px]">
			<div>{name}</div>
			<div className="font-mono text-ink-3">{qty}</div>
		</div>
	);
}

function DrivingBody() {
	return (
		<>
			<div className={`${card} flex flex-col gap-3 p-4`}>
				<div className="flex items-center justify-between text-base font-bold">
					<div>En Route</div>
					<div className="tabular-nums">14 min to start</div>
				</div>
				<div className="text-[15px] font-semibold text-brand">
					<span aria-hidden="true">⌖ </span>Losey Blvd S, La Crosse,
					WI
				</div>
				<div className="flex justify-between font-mono text-xs text-ink-4">
					<div>Scheduled 3:00 PM</div>
					<div>4.2 mi</div>
				</div>
			</div>
			{["Job context", "Work performed"].map((label) => (
				<div
					key={label}
					className={`${card} flex justify-between px-4 py-[15px]`}
				>
					<CardLabel>{label}</CardLabel>
					<div aria-hidden="true" className="text-xs text-ink-3">
						⌄
					</div>
				</div>
			))}
		</>
	);
}

function OnSiteBody() {
	return (
		<div className={`${card} overflow-hidden`}>
			<div className="border-b border-line-soft px-4 py-[13px]">
				<CardLabel>Job context</CardLabel>
			</div>
			<div className="flex flex-col gap-3 px-4 py-3.5">
				<div className="flex flex-col gap-0.5">
					<div className="text-xs text-ink-4">Description</div>
					<div className="text-[15px] leading-[1.45]">
						No cooling upstairs. Outdoor unit hums, fan not
						spinning.
					</div>
				</div>
				<div className="flex flex-col gap-1.5">
					<div className="text-xs text-ink-4">
						Assigned technicians
					</div>
					<div className="self-start rounded-full border border-line bg-paper px-2.5 py-[5px] text-[13px] font-semibold">
						Kevin Park
					</div>
				</div>
				<div className="flex flex-col gap-2.5 border-t border-line-soft pt-3">
					<div className="flex flex-col gap-0.5">
						<div className="text-xs text-ink-4">Client</div>
						<div className="text-[15px] font-semibold">
							Johnson Residence
						</div>
						<div className="text-[13px] text-ink-3">
							Robert Johnson · Primary
						</div>
					</div>
					<div className="flex gap-2 text-center text-[15px] font-semibold">
						<div className="flex-1 rounded-lg bg-brand-tint py-[13px] text-brand-deep">
							Call
						</div>
						<div className="flex-1 rounded-lg border border-line bg-paper py-[13px]">
							Email
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function WorkingBody({ demo }: { demo: VisitDemo }) {
	const elapsed = useElapsed(demo);

	return (
		<>
			{demo.status === "InProgress" ? (
				<div className="flex items-center gap-2.5 rounded-[10px] border border-brand-line bg-brand-tint px-4 py-3 text-brand-deep">
					<div className="size-2 rounded-full bg-brand" />
					<CardLabel className="text-brand-deep">
						In progress
					</CardLabel>
					<div className="ml-auto text-[17px] font-bold tabular-nums">
						{elapsed}
					</div>
				</div>
			) : (
				<div className="flex items-center gap-2.5 rounded-[10px] border border-amber-line bg-amber-tint px-4 py-3">
					<div className="size-2 rounded-full bg-amber-dot" />
					<CardLabel className="text-amber-ink">
						Paused · {demo.pauseReason}
					</CardLabel>
				</div>
			)}
			<div className={`${card} flex flex-col gap-2 px-4 py-3.5`}>
				<CardLabel>Work performed</CardLabel>
				<div className="text-[15px] leading-[1.45]">
					Condenser fan motor seized. Swapped motor, verified amp draw
					and cooling at registers.
				</div>
			</div>
			<div className={`${card} flex flex-col gap-2.5 px-4 py-3.5`}>
				<div className="flex items-center justify-between">
					<CardLabel>Parts used</CardLabel>
					<div className="text-sm font-semibold text-brand">
						+ Add
					</div>
				</div>
				<LineItem name="Blower Motor 1/2 HP 115V" qty="×1" />
				<LineItem name="Refrigerant R-410A" qty="×2 lb" />
				<div className="text-xs text-ink-4">From your van stock</div>
			</div>
		</>
	);
}

function CompletedBody({ laborMinutes }: { laborMinutes: number }) {
	return (
		<>
			<div className={`${card} overflow-hidden`}>
				<div className="border-b border-line-soft px-4 py-[13px]">
					<CardLabel>Invoice preview</CardLabel>
				</div>
				<div className="flex flex-col gap-2.5 px-4 py-3.5">
					<LineItem
						name="Service labor"
						qty={`${laborMinutes} min`}
					/>
					<LineItem name="Blower Motor 1/2 HP 115V" qty="×1" />
					<LineItem name="Refrigerant R-410A" qty="×2 lb" />
				</div>
			</div>
			<div className="px-0.5 text-[15px] leading-normal text-ink-2">
				Time, parts and notes are on the visit. The office sees it completed
				on the board.
			</div>
		</>
	);
}

const sheetButton =
	"cursor-pointer rounded-[10px] border border-line bg-white px-1.5 py-4 text-center text-[15px] font-semibold hover:bg-paper-2";

/** A technician's visit screen, working just like the field app at phone size. */
export default function PhoneDemo({ demo }: { demo: VisitDemo }) {
	const pill = STATUS_PILLS[demo.status];

	return (
		<div className="mx-auto flex min-w-0 flex-[0_1_360px] flex-col items-center gap-3.5">
			<div
				role="group"
				aria-label="Interactive technician app demo"
				className="flex h-[720px] w-[340px] max-w-full flex-col overflow-hidden rounded-[44px] border-[10px] border-ink bg-paper shadow-[0_30px_60px_-30px_rgba(23,27,29,0.35)]"
			>
				<div className="flex justify-between px-[22px] pb-1.5 pt-3 font-mono text-xs font-medium">
					<div>2:46</div>
					<div aria-hidden="true">LTE ▮▮▮</div>
				</div>
				<div className="flex items-center justify-between border-b border-line px-[18px] pb-2.5 pt-1.5">
					<div className="text-[15px] font-semibold text-brand">
						‹ Visits
					</div>
					<div className="font-mono text-[11px] text-ink-4">
						Kevin Park
					</div>
				</div>

				<div className="flex flex-1 flex-col gap-3.5 overflow-hidden px-4 pt-4">
					<div className="flex items-start justify-between gap-2.5">
						<div className="flex flex-col gap-0.5">
							<div className="text-[22px] font-bold tracking-[-0.015em]">
								AC Repair
							</div>
							<div className="text-[15px] text-ink-3">
								Johnson Residence
							</div>
						</div>
						<div className="sr-only" aria-live="polite">
							Visit status: {pill.label}
						</div>
						<div
							className={`whitespace-nowrap rounded-full px-2.5 py-[5px] text-xs font-bold ${pill.className}`}
						>
							{pill.label}
						</div>
					</div>

					{demo.status === "Driving" && <DrivingBody />}
					{demo.status === "OnSite" && <OnSiteBody />}
					{(demo.status === "InProgress" ||
						demo.status === "Paused") && (
						<WorkingBody demo={demo} />
					)}
					{demo.status === "Completed" && (
						<CompletedBody laborMinutes={demo.laborMinutes} />
					)}
				</div>

				<div className="flex flex-col gap-2 border-t border-line bg-paper p-3 px-3.5">
					{demo.pauseSheetOpen ? (
						<>
							<div className="px-0.5 pb-1 pt-0.5 text-base font-bold">
								Why are you pausing?
							</div>
							<div className="grid grid-cols-2 gap-2">
								{PAUSE_REASONS.map((reason) => (
									<button
										key={reason}
										type="button"
										onClick={() =>
											demo.pause(
												reason
											)
										}
										className={`${sheetButton} ${reason === "Other" ? "col-span-2" : ""}`}
									>
										{reason}
									</button>
								))}
							</div>
							<button
								type="button"
								onClick={demo.closePauseSheet}
								className="cursor-pointer rounded-[10px] py-3.5 text-center text-[15px] font-semibold text-ink-3 hover:text-ink"
							>
								Cancel
							</button>
						</>
					) : (
						<>
							<div className="flex gap-2">
								{demo.status === "InProgress" && (
									<button
										type="button"
										onClick={
											demo.openPauseSheet
										}
										className="flex-1 cursor-pointer rounded-[10px] border-[1.5px] border-ink bg-white py-[18px] text-center text-base font-semibold hover:bg-paper-2"
									>
										Pause Visit
									</button>
								)}
								<button
									type="button"
									onClick={demo.advance}
									className="flex-1 cursor-pointer select-none rounded-[10px] bg-lime py-[19px] text-center text-[17px] font-bold text-lime-ink hover:bg-lime-hover motion-safe:transition-transform motion-safe:active:scale-[0.98]"
								>
									{demo.primaryLabel}
								</button>
							</div>
							{demo.status === "InProgress" && (
								<div className="rounded-[10px] border border-line py-2.5 text-center text-sm font-semibold text-ink-4">
									Clock Out
								</div>
							)}
						</>
					)}
				</div>

				<div className="flex justify-around border-t border-line bg-white px-2 pb-3.5 pt-2.5 text-[11px] font-semibold text-ink-4">
					<div>Today</div>
					<div className="text-brand">Visits</div>
					<div>Map</div>
					<div>Vehicle</div>
					<div>Profile</div>
				</div>
			</div>
			<button
				type="button"
				onClick={demo.reset}
				className="cursor-pointer px-3 py-2.5 font-mono text-xs text-ink-4 hover:text-ink"
			>
				<span aria-hidden="true">↺ </span>Reset visit
			</button>
		</div>
	);
}
