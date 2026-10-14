import { SplitIntro } from "./primitives";

const container = "mx-auto max-w-[1200px] px-6";

// Built-in reports as the Insights hub groups them (ReportSection.tsx). QB marks
// the ones that render straight from a connected QuickBooks company.
const REPORTS: [string, [string, boolean?][]][] = [
	[
		"Money",
		[
			["Job Profitability"],
			["Cost of Goods Sold"],
			["Aged Receivables"],
			["Recurring Revenue"],
			["Tax Liability"],
			["Profit & Loss", true],
			["Balance Sheet", true],
			["Cash Flow", true],
		],
	],
	[
		"Operations",
		[["Job Backlog"], ["Quote Conversion"], ["First-Time Fix Rate"], ["Reorder Forecast"]],
	],
	["Technicians", [["Technician Scorecard"], ["Timesheets"], ["Field-Added Revenue"]]],
	["Clients", [["Client Lifetime Value"], ["Client Retention"], ["Client Discounts"]]],
];

const ROWS: [string, string, string, string][] = [
	["J-1042", "Smith Commercial Properties", "Sep 26", "$18,450.00"],
	["J-1037", "Anderson Office Complex", "Sep 19", "$9,860.00"],
	["J-1029", "Riverside Apartments LLC", "Sep 12", "$7,215.50"],
	["J-1024", "Williams Property Management", "Sep 4", "$5,390.00"],
];

const FILTERS = ["Status equals Completed", "and Actual Total ≥ $5,000", "and Completed in last 30 days"];

function BuilderPreview() {
	return (
		<div className="min-w-0 flex-[1_1_540px] overflow-hidden rounded-[14px] border border-line bg-white shadow-[0_24px_50px_-30px_rgba(23,27,29,0.25)]">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="text-lg font-bold">Big jobs this month</div>
					<div className="text-[13px] text-ink-4">Saved report · Jobs</div>
				</div>
				<div className="flex gap-2 text-sm font-semibold">
					<div className="rounded-lg border border-line px-3.5 py-2">Customize</div>
					<div className="rounded-lg bg-brand px-3.5 py-2 text-white">Export</div>
				</div>
			</div>
			<div className="flex flex-wrap gap-1.5 border-b border-line-soft bg-paper px-5 py-3">
				{FILTERS.map((f) => (
					<div
						key={f}
						className="rounded-full border border-line bg-white px-2.5 py-1 text-[13px] font-medium text-ink-2"
					>
						{f}
					</div>
				))}
			</div>
			<div className="overflow-x-auto">
				<table className="w-full min-w-[440px] border-collapse text-sm">
					<thead>
						<tr className="text-left font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
							<th scope="col" className="px-5 py-2.5 font-medium">
								Job #
							</th>
							<th scope="col" className="py-2.5 pr-3 font-medium">
								Client
							</th>
							<th scope="col" className="py-2.5 pr-3 font-medium">
								Completed
							</th>
							<th scope="col" className="py-2.5 pr-5 text-right font-medium">
								Actual Total
							</th>
						</tr>
					</thead>
					<tbody>
						{ROWS.map(([job, client, date, total]) => (
							<tr key={job} className="border-t border-line-soft">
								<td className="px-5 py-3 font-mono text-[13px] text-ink-3">
									{job}
								</td>
								<td className="py-3 pr-3 font-semibold">{client}</td>
								<td className="py-3 pr-3 text-ink-3">{date}</td>
								<td className="py-3 pr-5 text-right font-mono tabular-nums">
									{total}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

export function ReportingSection() {
	return (
		<section id="reporting" className="scroll-mt-16 border-t border-line">
			<div className={`${container} flex flex-col gap-11 py-[88px]`}>
				<SplitIntro title="Know which jobs made money.">
					Job profitability, cost of goods sold and client lifetime value
					are built in. When a question isn't, build the report yourself:
					pick a source, the columns and the filters, save it, and export
					to Excel.
				</SplitIntro>
				<div className="flex flex-wrap items-start gap-x-12 gap-y-10">
					<BuilderPreview />
					<div className="flex min-w-0 flex-[1_1_320px] flex-col gap-7">
						<div className="grid grid-cols-2 gap-x-8 gap-y-6">
							{REPORTS.map(([group, items]) => (
								<div key={group} className="flex flex-col gap-2">
									<h3 className="m-0 text-base font-bold">{group}</h3>
									<ul className="m-0 flex list-none flex-col gap-1 p-0 text-[15px] text-ink-2">
										{items.map(([name, qb]) => (
											<li key={name}>
												{name}
												{qb && (
													<span className="ml-1.5 rounded bg-brand-tint px-1.5 py-px text-[11px] font-bold text-brand-deep">
														QuickBooks
													</span>
												)}
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
						<p className="m-0 border-t border-line pt-5 text-[15px] leading-[1.55] text-ink-2">
							<span className="font-semibold text-ink">
								A KPI board you arrange.
							</span>{" "}
							Backlog, revenue, quote pipeline, arrival performance,
							receivables. Add the widgets you watch, drag and resize
							them, and each dispatcher keeps their own layout.
						</p>
					</div>
				</div>
			</div>
		</section>
	);
}
