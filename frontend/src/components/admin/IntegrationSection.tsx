import { useState } from "react";
import type { ReactNode } from "react";
import QuickBooksSection from "../quickbooks/QuickBooksSection";
import ZapierSection from "../zapier/ZapierSection";
import QuickBooksUnsyncedCard from "./QuickBooksUnsyncedCard";
import { usePermission } from "../../hooks/usePermission";
import { useQBStatusQuery } from "../../hooks/useQuickbooks";
import { QUICKBOOKS_ENABLED } from "../../config/features";

const INTEGRATIONS = [
	{
		id: "quickbooks",
		label: "QuickBooks",
		brand: "#2ca01c",
		kind: "connection",
		render: () => <QuickBooksSection />,
		desc: "Sync invoices, customers, items, and tax codes with QuickBooks Online.",
	},
	{
		id: "zapier",
		label: "Zapier",
		brand: "#ff4f00",
		kind: "embed",
		render: () => <ZapierSection />,
		desc: "Automate workflows across 6,000+ apps with Zapier.",
	},
];

function StatusBadge({
	tone,
	dot,
	children,
}: {
	tone: "success" | "warning" | "error" | "info";
	dot?: boolean;
	children: ReactNode;
}) {
	const map = {
		success: "text-success-text bg-success-bg border-success-border",
		warning: "text-warning-text bg-warning-bg border-warning-border",
		error: "text-error-text bg-error-bg border-error-border",
		info: "text-primary-text bg-primary-bg border-primary-border",
	};

	return (
		<span
			className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${map[tone]}`}
		>
			{dot && <span className="inline-block shrink-0 w-2 h-2 rounded-full bg-current opacity-80" />}
			{children}
		</span>
	);
}

export default function IntegrationSection() {
	const MANAGE_ORGANIZATION = usePermission("manage_organization");
	const { data: qbStatus } = useQBStatusQuery();
	const qbConnected = !!qbStatus?.connected;
	const [selected, setSelected] = useState<string>(INTEGRATIONS[0].id);

	if (!MANAGE_ORGANIZATION) return null;

	const active = INTEGRATIONS.find((int) => int.id === selected);

	return (
		<>
			{/* Integration Cards */}
			<div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
				{INTEGRATIONS.map((int) => {
                    // Will need to change once more integrations with connections are added
					const connected = int.id === "quickbooks" && qbConnected;
						// QuickBooks temporarily disabled (see config/features)
						const qbUnavailable = int.id === "quickbooks" && !QUICKBOOKS_ENABLED;

					return (
						<button
							type="button"
							key={int.id}
							className={[
								"flex flex-col gap-3 text-left p-[18px] rounded-xl border bg-base",
								"transition-colors hover:border-border focus-visible:outline-2 focus-visible:outline-primary",
								selected === int.id
									? "border-primary ring-1 ring-primary"
									: "border-border-card",
							].join(" ")}
							onClick={() => setSelected(int.id)}
						>
							<div className="flex items-center gap-2.5 justify-between">
								<span className="flex items-center gap-2.5 font-semibold text-text-primary">
									<span
										className="w-2.5 h-2.5 rounded-[3px] shrink-0"
										style={{ background: int.brand }}
									/>
									{int.label}
								</span>
								{qbUnavailable || int.kind !== "connection" ? (
									<StatusBadge tone="error">Unavailable</StatusBadge>
								) : connected ? (
									<StatusBadge tone="success" dot>
										Connected
									</StatusBadge>
								) : (
									<StatusBadge tone="warning" dot>
										Not connected
									</StatusBadge>
								)}
							</div>
							<p className="text-sm text-text-muted leading-relaxed flex-1">{int.desc}</p>
							<span className="text-[12.5px] font-semibold text-primary-text">
								{qbUnavailable
									? "Unavailable"
									: int.kind === "connection"
										? connected
											? "Manage →"
											: "Set up →"
										: "Open →"}
							</span>
						</button>
					);
				})}
			</div>
			{/* Selected Integration Render */}
			<div className="mt-5 pt-5 border-t border-border-subtle">
				<h2 className="text-lg font-semibold text-text-primary pb-3">{active?.label}</h2>
				{active?.id === "quickbooks" && <QuickBooksUnsyncedCard connected={qbConnected} />}
				{active?.render()}
			</div>
		</>
	);
}
