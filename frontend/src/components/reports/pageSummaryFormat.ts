// One-sentence explanation per stat shown as a hover title on the label
export const STAT_DESCRIPTIONS: Record<string, Record<string, string>> = {
	jobs: {
		Total: "Number of jobs created in the selected range.",
		Open: "Jobs currently Unscheduled, Scheduled, or In Progress.",
		Unscheduled: "Combined estimated value of every job still unscheduled.",
		Revenue: "Revenue from job visits completed in the selected range.",
	},
	quotes: {
		Total: "Quotes created in the selected range.",
		Open: "Quotes currently open (Draft, Sent, Viewed, or Disputed).",
		Pipeline: "Total dollar value of every open quote.",
		Approved: "Total dollar value of quotes created in the range and approved.",
		"Approve Time": "Average time from a quote being sent to being approved.",
	},
	requests: {
		Total: "Requests created in the selected range.",
		Open: "Requests currently open (New or Reviewing).",
		Converted: "Requests created in the range that were converted into a job.",
		"Est. Value": "Combined estimated value of requests in the range.",
	},
	invoices: {
		Total: "Invoices created in the selected range.",
		Created: "Total amount billed on invoices created in the range.",
		Collected: "Payments received in the selected range.",
		"Avg. Days to Pay": "Average number of days from invoice creation to payment.",
		Outstanding: "Unpaid balance across issued invoices, disputed included, net of credits.",
		Overdue: "Unpaid balance on invoices past their due date (disputed excluded).",
	},
	clients: {
		New: "Clients added in the selected range.",
		Active: "Clients currently marked active.",
		"Open Balance": "Total outstanding balance owed across all clients.",
		"Avg. Income": "Average billed revenue per client (total billed ÷ all clients).",
	},
	projects: {
		Total: "Projects created in the selected range.",
		Open: "Projects currently open (Planning, Active, or On Hold).",
		Overdue: "Projects past their target end date and not yet completed.",
		Budget: "Combined budget of projects created in the range.",
		Committed:
			"Value of jobs attached to those projects — actual where the job is finished, otherwise estimated.",
	},
	inventory: {
		"Total Items": "Active, non-provisional inventory items (current snapshot).",
		Low: "Items at or below their low-stock threshold.",
		"Out of Stock": "Items with zero quantity on hand.",
		"Asset Value": "Value of stock on hand in the warehouse and on vehicles, including discontinued items (quantity × cost).",
	},
	recurring_plans: {
		Total: "Plans in effect at any point in the selected range.",
		Active: "Plans currently active.",
		Paused: "Plans currently paused.",
		"Ending Soon":
			"Active or paused plans whose end date is in the next 30 days or has already passed.",
	},
};

export function formatStat(
	value: number,
	format: "number" | "currency" | "percent" | "duration",
	{ compact = false, wholeDollars = false }: { compact?: boolean; wholeDollars?: boolean } = {},
): string {
	switch (format) {
		case "currency":
			return value.toLocaleString(undefined, {
				style: "currency",
				currency: "USD",
				...(compact
					? { notation: "compact", maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : 0 }
					: wholeDollars
						? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
						: {}),
			});
		case "percent":
			return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
		case "duration": {
			if (!Number.isFinite(value) || value <= 0) return "—";
			if (value < 1) {
				const hrs = value * 24;
				return `${hrs.toLocaleString(undefined, { maximumFractionDigits: 1 })} hr${hrs === 1 ? "" : "s"}`;
			}
			const days = Number(value.toFixed(1));
			return `${days.toLocaleString(undefined, { maximumFractionDigits: 1 })} day${days === 1 ? "" : "s"}`;
		}
		default:
			return value.toLocaleString();
	}
}
