import { CardLabel, SectionTitle } from "./primitives";

const container = "mx-auto max-w-[1200px] px-6";

// Wording mirrors the field app: AuthorityStrip, ReceiptValueDiff and LimitBreachNotice.
const AUTHORITY: [string, string, boolean?][] = [
	["Per purchase", "$150"],
	["Left today", "$212"],
	["Left this week", "$48", true],
];

const FIELDS: { label: string; entered: string; reads?: string }[] = [
	{ label: "Vendor", entered: "Johnstone Supply" },
	{ label: "Date", entered: "Sep 30, 2026" },
	{ label: "Tax", entered: "$11.42" },
	{ label: "Total", entered: "$168.40", reads: "$186.40" },
];

const CONTROLS: [string, string][] = [
	[
		"A limit for every tech",
		"Set how much each tech can spend per purchase, per day, per week and per job. Going over doesn't block the buy. It goes to dispatch to approve.",
	],
	[
		"The receipt checks the typing",
		"Snap the receipt and it's read for vendor, date, tax, total and line items. Where it disagrees with what the tech typed, both numbers sit side by side. Nothing is overwritten.",
	],
	[
		"One receipt, one reimbursement",
		"The same photo, the same receipt number or the same vendor, day and total can't be claimed twice. Near-misses get flagged for the reviewer.",
	],
	[
		"Two signatures on big spends",
		"Set a threshold and anything above it needs a second approver, never the first one and never the buyer. Stock doesn't move until both have signed.",
	],
];

function SubmitCard() {
	return (
		<div className="flex min-w-0 flex-col gap-3.5 rounded-[20px] border border-line bg-white p-5 shadow-[0_24px_50px_-30px_rgba(23,27,29,0.25)]">
			<div className="flex items-baseline justify-between gap-3">
				<div className="text-[17px] font-bold">Record a field purchase</div>
				<div className="font-mono text-xs text-ink-4">AC Repair · Johnson</div>
			</div>

			<dl className="m-0 grid grid-cols-3 overflow-hidden rounded-[10px] border border-line text-center">
				{AUTHORITY.map(([label, value, low]) => (
					<div
						key={label}
						className="flex flex-col gap-0.5 border-r border-line px-2 py-2.5 last:border-r-0"
					>
						<dt className="text-xs text-ink-4">{label}</dt>
						<dd
							className={`m-0 font-mono text-[15px] font-bold ${low ? "text-amber-ink" : ""}`}
						>
							{value}
						</dd>
					</div>
				))}
			</dl>

			<div className="flex flex-col divide-y divide-line-soft rounded-[10px] border border-line">
				{FIELDS.map((f) => (
					<div
						key={f.label}
						className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5"
					>
						<div className="text-[13px] text-ink-4">{f.label}</div>
						<div className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
							<div className="text-[15px] font-semibold">{f.entered}</div>
							{f.reads && (
								<div className="flex items-center gap-1.5 rounded-full bg-sky px-2.5 py-1 text-xs text-sky-3">
									receipt reads{" "}
									<span className="font-mono font-bold">
										{f.reads}
									</span>
									<span className="font-semibold text-sky-btn underline underline-offset-2">
										use it
									</span>
								</div>
							)}
						</div>
					</div>
				))}
			</div>

			<div className="flex flex-col gap-2 rounded-[10px] border border-amber-line bg-amber-tint px-3.5 py-3 text-amber-ink">
				<div className="text-sm font-bold">
					<span aria-hidden="true">⚠ </span>Over a limit — dispatch has to approve it
				</div>
				<div className="flex flex-wrap justify-between gap-x-3 text-[13px]">
					<div className="font-semibold">Per purchase $150</div>
					<div>Come down $18.40</div>
				</div>
			</div>
		</div>
	);
}

export function PurchaseControlsSection() {
	return (
		<section id="purchases" className="scroll-mt-16 border-t border-line bg-white">
			<div className={`${container} flex flex-wrap items-start gap-x-14 gap-y-12 py-[88px]`}>
				<div className="flex min-w-0 flex-[1_1_460px] flex-col gap-9">
					<div className="flex flex-col gap-4">
						<SectionTitle>Every dollar off the truck has a limit and a receipt.</SectionTitle>
						<p className="m-0 max-w-[560px] text-pretty text-lg leading-[1.55] text-ink-2">
							Techs buy what the job needs at the counter. You decide
							how much they can spend, and every purchase shows up for
							review with its receipt photo.
						</p>
					</div>
					<div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-x-9 gap-y-7">
						{CONTROLS.map(([title, body]) => (
							<div key={title} className="flex flex-col gap-1.5">
								<h3 className="m-0 text-[17px] font-semibold">{title}</h3>
								<p className="m-0 text-[15px] leading-[1.55] text-ink-3">
									{body}
								</p>
							</div>
						))}
					</div>
				</div>
				<div className="flex min-w-0 flex-[1_1_360px] flex-col gap-3 lg:max-w-[440px]">
					<CardLabel>What the tech sees</CardLabel>
					<SubmitCard />
				</div>
			</div>
		</section>
	);
}
