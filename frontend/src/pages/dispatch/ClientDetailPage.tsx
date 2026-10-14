import { useState, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
	Edit,
	Briefcase,
	FileText,
	Phone,
	Repeat,
	ArrowRight,
	Clock,
	MapPin,
	Calendar,
	ReceiptText,
	RefreshCw,
	CheckCircle2,
} from "lucide-react";
import Card from "../../components/ui/Card";
import EditClientModal from "../../components/clients/EditClient";
import ContactManager from "../../components/clients/ContactManager";
import NoteManager from "../../components/clients/NoteManager";
import ClientDisputesCard from "../../components/clients/ClientDisputesCard";
import { useClientByIdQuery } from "../../hooks/useClients";
import { useInvoicesByClientIdQuery } from "../../hooks/useInvoices";
import {
	InvoiceStatusColors,
	InvoiceStatusLabels,
	type InvoiceStatus,
} from "../../types/invoices";
import { QuoteStatusColors, type QuoteStatus } from "../../types/quotes";
import { formatCurrency, formatDate } from "../../util/util";
import { usePermission } from "../../hooks/usePermission";
import ChangeHistory from "../../components/activity/ChangeHistory";
import {
	useQBClientSyncMutation,
	useQBStatusQuery,
	useQBMappedCustomersQuery,
} from "../../hooks/useQuickbooks";
import { useToast } from "../../components/ui/useToast";

type MainTab = "active" | "requests" | "quotes" | "jobs" | "plans" | "invoices";
const ITEMS_LIMIT = 8;

interface WorkflowItem {
	id: string;
	type: "request" | "quote" | "job" | "plan" | "invoice";
	title: string;
	status: string;
	statusLabel?: string;
	created_at: Date | string;
	address?: string;
	total?: number | string;
	number?: string;
	starts_at?: Date | string;
	priority?: string;
	is_active?: boolean;
}

export default function ClientDetailsPage() {
	const { clientId } = useParams<{ clientId: string }>();
	const navigate = useNavigate();
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [activeTab, setActiveTab] = useState<MainTab>("active");

	const { data: client, isLoading, error } = useClientByIdQuery(clientId!);
	const { data: invoices } = useInvoicesByClientIdQuery(clientId!);

	const toast = useToast();
	const qbClientSync = useQBClientSyncMutation();
	const { data: qbStatus } = useQBStatusQuery();
	const { data: qbMappedCustomers } = useQBMappedCustomersQuery();

	// ── QuickBooks sync state (shared by header badge + sync action) ──
	const qbConnected = !!qbStatus?.connected;
	const qbMapping = qbMappedCustomers?.find((m) => m.client_id === clientId);
	const qbSynced = qbConnected && !!qbMapping;
	const qbShowAction = qbConnected && !qbSynced;

	const handleSync = async () => {
		if (!clientId) return;
		try {
			await qbClientSync.mutateAsync({ client_id: clientId });
			toast.success("Synced to QuickBooks");
		} catch (error) {
			console.error("Error syncing client to QuickBooks:", error);
			toast.error(error instanceof Error ? error.message : "Failed to sync client to QuickBooks");
		}
	};

	//permissions
	const EDIT_CLIENT = usePermission("edit_clients");

	const workflowData = useMemo(() => {
		if (!client) return { active: [], requests: [], quotes: [], jobs: [], plans: [], invoices: [] };

		const requests: WorkflowItem[] = (client.requests || []).map((r) => ({
			id: r.id,
			type: "request",
			title: r.title,
			status: r.status,
			created_at: r.created_at,
			address: client.address,
			priority: r.priority,
		}));

		const quotes: WorkflowItem[] = (client.quotes || []).map((q) => ({
			id: q.id,
			type: "quote",
			title: q.title,
			number: q.quote_number,
			status: q.status,
			created_at: q.created_at,
			address: client.address,
			total: q.total,
			priority: q.priority,
			is_active: q.is_active,
		}));

		const jobs: WorkflowItem[] = (client.jobs || []).map((j) => ({
			id: j.id,
			type: "job",
			title: j.name,
			number: j.job_number,
			status: j.status,
			created_at: j.created_at,
			address: j.address || client.address,
			total: (j.actual_total || j.estimated_total) ?? undefined,
			priority: j.priority,
		}));

		const plans: WorkflowItem[] = (client.recurring_plans || []).map((p) => ({
			id: p.id,
			type: "plan",
			title: p.name,
			status: p.status,
			created_at: p.created_at,
			starts_at: p.starts_at,
			address: client.address,
		}));

		const invoiceItems: WorkflowItem[] = (invoices ?? []).map((inv) => ({
			id: inv.id,
			type: "invoice" as const,
			title: inv.memo || "Invoice",
			number: inv.invoice_number,
			status: inv.status,
			statusLabel: InvoiceStatusLabels[inv.status],
			created_at: inv.created_at,
			starts_at: inv.issue_date ?? undefined,
			address: client.address,
			total: inv.balance_due,
		}));

		const isActiveRequest = (r: WorkflowItem) =>
			r.status !== "Cancelled" && r.status !== "ConvertedToJob";
		const isActiveQuote = (q: WorkflowItem) =>
			q.status !== "Cancelled" && q.status !== "Rejected" && q.is_active;
		const isActiveJob = (j: WorkflowItem) =>
			j.status !== "Cancelled" && j.status !== "Completed";
		const isActivePlan = (p: WorkflowItem) => p.status === "Active";
		const isActiveInvoice = (i: WorkflowItem) =>
			i.status !== "Paid" && i.status !== "Void";

		const active: WorkflowItem[] = [
			...requests.filter(isActiveRequest),
			...quotes.filter(isActiveQuote),
			...jobs.filter(isActiveJob),
			...plans.filter(isActivePlan),
			...invoiceItems.filter(isActiveInvoice),
		].sort(
			(a, b) =>
				new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
		);

		return { active, requests, quotes, jobs, plans, invoices: invoiceItems };
	}, [client, invoices]);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center min-h-[400px]">
				<div className="text-text-tertiary">Loading...</div>
			</div>
		);
	}

	if (error || !client) {
		return (
			<div className="w-full px-4 sm:px-6 lg:px-8 py-6">
				<button
					onClick={() => navigate("/dispatch/clients")}
					className="text-text-tertiary hover:text-text-primary mb-4 transition-colors"
				>
					← Back to Clients
				</button>
				<div className="text-text-primary">Client not found</div>
			</div>
		);
	}

	const getStatusColor = (item: WorkflowItem) => {
		if (item.type === "invoice") {
			return InvoiceStatusColors[item.status as InvoiceStatus]
				?? "bg-neutral/20 text-text-tertiary border-border-strong/30";
		}
		if (item.type === "quote") {
			return QuoteStatusColors[item.status as QuoteStatus]
				?? "bg-neutral/20 text-text-tertiary border-border-strong/30";
		}
		const colors: Record<string, string> = {
			New: "bg-primary/20 text-primary-text border-primary/30",
			Reviewing: "bg-reviewing/20 text-reviewing-text border-reviewing/30",
			Quoted: "bg-warning/20 text-warning-text border-warning/30",
			Draft: "bg-neutral/20 text-text-tertiary border-border-strong/30",
			Sent: "bg-primary/20 text-primary-text border-primary/30",
			Viewed: "bg-reviewing/20 text-reviewing-text border-reviewing/30",
			Approved: "bg-success/20 text-success-text border-success/30",
			Rejected: "bg-error/20 text-error-text border-error/30",
			Unscheduled: "bg-orange/20 text-orange-text border-orange/30",
			Scheduled: "bg-primary/20 text-primary-text border-primary/30",
			InProgress: "bg-warning/20 text-warning-text border-warning/30",
			Completed: "bg-success/20 text-success-text border-success/30",
			Cancelled: "bg-neutral/20 text-text-tertiary border-border-strong/30",
			ConvertedToJob: "bg-success/20 text-success-text border-success/30",
			Active: "bg-success/20 text-success-text border-success/30",
			Paused: "bg-warning/20 text-warning-text border-warning/30",
		};
		return colors[item.status] || "bg-neutral/20 text-text-tertiary border-border-strong/30";
	};

	const getTypeIcon = (type: string) => {
		const iconClass = "flex-shrink-0";
		switch (type) {
			case "request":
				return <Phone size={16} className={`${iconClass} text-primary-text`} />;
			case "quote":
				return (
					<FileText
						size={16}
						className={`${iconClass} text-warning-text`}
					/>
				);
			case "job":
				return (
					<Briefcase
						size={16}
						className={`${iconClass} text-success-text`}
					/>
				);
			case "plan":
				return (
					<Repeat
						size={16}
						className={`${iconClass} text-reviewing-text`}
					/>
				);
			case "invoice":
				return (
					<ReceiptText
						size={16}
						className={iconClass + " text-success-text"}
					/>
				);
			default:
				return null;
		}
	};

	const tabs = [
		{
			id: "active" as MainTab,
			label: "Active",
			count: workflowData.active.length,
			icon: Clock,
		},
		{
			id: "requests" as MainTab,
			label: "Requests",
			count: workflowData.requests.length,
			icon: Phone,
			color: "text-primary-text",
			inactiveColor: "text-primary-text/40",
		},
		{
			id: "quotes" as MainTab,
			label: "Quotes",
			count: workflowData.quotes.length,
			icon: FileText,
			color: "text-warning-text",
			inactiveColor: "text-warning-text/40",
		},
		{
			id: "jobs" as MainTab,
			label: "Jobs",
			count: workflowData.jobs.length,
			icon: Briefcase,
			color: "text-success-text",
			inactiveColor: "text-success-text/40",
		},
		{
			id: "plans" as MainTab,
			label: "Plans",
			count: workflowData.plans.length,
			icon: Repeat,
			color: "text-reviewing-text",
			inactiveColor: "text-reviewing-text/40",
		},
		{
			id: "invoices" as MainTab,
			label: "Invoices",
			count: workflowData.invoices.length,
			icon: ReceiptText,
			color: "text-success-text",
			inactiveColor: "text-success-text/40",
		},
	];

	const currentData = workflowData[activeTab];
	const isActiveTab = activeTab === "active";
	const displayData = isActiveTab ? currentData : currentData.slice(0, ITEMS_LIMIT);
	const hasMoreItems = currentData.length > ITEMS_LIMIT;

	const handleItemClick = (item: WorkflowItem) => {
		const path = item.type === "plan" ? "recurring-plans" : `${item.type}s`;
		navigate(`/dispatch/${path}/${item.id}`);
	};

	const handleViewAll = () => {
		if (activeTab === "active") {
			navigate(`/dispatch/clients/${clientId}/active`);
		} else {
			const path = activeTab === "plans" ? "recurring-plans" : activeTab;
			navigate(`/dispatch/${path}?client=${clientId}`);
		}
	};

	const renderWorkflowItem = (item: WorkflowItem) => (
		<button
			key={`${item.type}-${item.id}`}
			onClick={() => handleItemClick(item)}
			className="w-full grid grid-cols-[40px_1fr] sm:grid-cols-[40px_1fr_100px_90px] gap-3 px-3 sm:px-4 py-3 text-left transition-colors hover:bg-surface/50 group"
		>
			<div className="flex items-center justify-center">
				{getTypeIcon(item.type)}
			</div>
			<div className="min-w-0">
				<div className="flex items-center gap-2 mb-1">
					<span className="text-sm font-medium text-text-secondary group-hover:text-primary-text transition-colors truncate">
						{item.number ? `${item.number} - ` : ""}
						{item.title}
					</span>
				</div>
				<div className="flex items-start gap-1 text-xs text-text-muted">
					<MapPin size={11} className="mt-0.5 flex-shrink-0" />
					<span className="line-clamp-2">{item.address}</span>
				</div>
				<div className="sm:hidden mt-2 flex items-center justify-between">
					<span
						className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getStatusColor(item)}`}
					>
						{item.statusLabel ?? item.status}
					</span>
					{item.total !== undefined && item.total !== null && (
						<span className="text-xs text-success-text font-medium">
							{formatCurrency(Number(item.total))}
						</span>
					)}
				</div>
			</div>
			<div className="hidden sm:flex flex-col justify-center text-xs min-w-0">
				<div className="flex items-center gap-1 text-text-tertiary">
					<Calendar size={11} />
					<span className="truncate">
						{(item.type === "plan" || item.type === "invoice") && item.starts_at
							? formatDate(item.starts_at)
							: formatDate(item.created_at)}
					</span>
				</div>
				{item.total !== undefined && item.total !== null && (
					<div className="flex items-center gap-1 text-success-text font-medium mt-1">
						<span className="truncate">
							{formatCurrency(Number(item.total))}
						</span>
					</div>
				)}
			</div>
			<div className="hidden sm:flex items-center justify-end">
				<span
					className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getStatusColor(item)}`}
				>
					{item.statusLabel ?? item.status}
				</span>
			</div>
		</button>
	);

	const renderEmptyState = () => {
		const Icon = tabs.find((t) => t.id === activeTab)?.icon || Clock;
		return (
			<div className="text-center py-12 px-4">
				<Icon
					size={32}
					className={
						activeTab === "active"
							? "text-success/30 mx-auto mb-3"
							: "text-text-muted mx-auto mb-3"
					}
				/>
				{activeTab === "active" ? (
					<>
						<p className="text-sm text-text-muted mb-1">
							All caught up!
						</p>
						<p className="text-xs text-text-faint">
							No active items for this client
						</p>
					</>
				) : (
					<p className="text-sm text-text-muted">
						No{" "}
						{activeTab === "plans"
							? "recurring plans"
							: activeTab}{" "}
						yet
					</p>
				)}
			</div>
		);
	};

	return (
		<div className="min-h-0 bg-canvas text-text-primary w-full">
			<div className="w-full px-4 sm:px-5 lg:px-6 py-4">
				{/* Header */}
				<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
					<div className="min-w-0">
						<h1 className="text-lg sm:text-xl lg:text-2xl font-bold text-text-primary truncate">
							{client.name}
						</h1>
					</div>

					<div className="flex items-center gap-2 flex-shrink-0">
						<span
							className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${
								client.is_active
									? "bg-success/20 text-success-text border-success/30"
									: "bg-error/20 text-error-text border-error/30"
							}`}
						>
							{client.is_active ? "Active" : "Inactive"}
						</span>
							{qbConnected && qbSynced && (
								<span
									className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap bg-success-bg text-success-bright-text border-success-border"
									title={`Synced to QuickBooks customer #${qbMapping?.external_id}`}
								>
									<CheckCircle2 size={11} />
									In QuickBooks
								</span>
							)}
							{qbShowAction && (
								<button
									title={!EDIT_CLIENT ? "You don't have permission to perform this action" : "Create this client as a customer in QuickBooks Online"}
									disabled={!EDIT_CLIENT || qbClientSync.isPending}
									className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-quickbooks hover:enabled:bg-quickbooks-hover text-white transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
									onClick={() => {
										if (!EDIT_CLIENT) return;
										handleSync();
									}}
								>
									<RefreshCw size={12} className={qbClientSync.isPending ? "animate-spin" : undefined} />
									<span className="hidden sm:inline">
										{qbClientSync.isPending ? "Syncing…" : "Sync to QuickBooks"}
									</span>
								</button>
							)}
							<button
								title={!EDIT_CLIENT ? "You don't have permission to perform this action" : undefined}
								disabled={!EDIT_CLIENT}
								className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-hover hover:bg-primary-active text-on-primary rounded text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
								onClick={() => {
									if (!EDIT_CLIENT) return;
									setIsEditModalOpen(true);
								}}
							>
								<Edit size={12} />
								<span className="hidden sm:inline">
									Edit
								</span>
							</button>
					</div>
				</div>

				{/* Two Column Layout with Responsive Ordering */}
				<div className="grid grid-cols-1 xl:grid-cols-[1fr_minmax(300px,28%)] gap-4 lg:gap-5 items-start">
					{/* LEFT COLUMN (Workflow + Notes)	*/}
					<div className="flex flex-col gap-4 lg:gap-5 min-w-0 order-3 xl:order-1">
						{/* Workflow Section */}
						<div className="bg-base border border-border-subtle rounded-lg overflow-hidden flex flex-col">
							{/* Tab Bar */}
							<div className="flex items-stretch border-b border-border overflow-x-auto scrollbar-hide">
								{tabs.map((tab) => {
									const Icon = tab.icon;
									const isActive =
										activeTab ===
										tab.id;

									return (
										<button
											key={tab.id}
											onClick={() =>
												setActiveTab(
													tab.id
												)
											}
											className={`flex-1 min-w-[70px] sm:min-w-[80px] flex items-center justify-center gap-1.5 py-2.5 sm:py-3 px-2 border-b-2 transition-all whitespace-nowrap ${
												isActive
													? "border-primary bg-primary-bg text-text-primary"
													: "border-transparent hover:bg-surface/20 text-text-muted hover:text-text-secondary"
											}`}
										>
											<Icon
												size={
													14
												}
												className={`flex-shrink-0 transition-colors ${
													isActive
														? tab.color
														: tab.inactiveColor
												}`}
											/>
											<span className="text-xs font-medium hidden sm:inline">
												{
													tab.label
												}
											</span>
											<span
												className={`text-xs font-bold ${
													isActive
														? "text-primary-text"
														: "text-text-faint"
												}`}
											>
												{
													tab.count
												}
											</span>
										</button>
									);
								})}
							</div>

							{/* Table Header */}
							<div className="hidden sm:grid grid-cols-[40px_1fr_100px_90px] gap-3 px-4 py-2 bg-base/50 border-b border-border text-[10px] uppercase font-semibold text-text-muted tracking-wide">
								<div aria-hidden="true"></div>
								<div>Details</div>
								<div>Date/Amount</div>
								<div className="text-right">
									Status
								</div>
							</div>

							{/* Content Area */}
							{isActiveTab ? (
								<div className="overflow-y-auto scrollbar-on-hover max-h-[min(480px,60vh)]">
									{displayData.length > 0 ? (
										<div className="divide-y divide-border-subtle/50">
											{displayData.map(
												renderWorkflowItem
											)}
										</div>
									) : (
										renderEmptyState()
									)}
								</div>
							) : (
								<div className="divide-y divide-border-subtle/50">
									{displayData.length > 0
										? displayData.map(
												renderWorkflowItem
											)
										: renderEmptyState()}
								</div>
							)}

							{/* View All Button */}
							{!isActiveTab && hasMoreItems && (
								<div className="border-t border-border p-3 bg-base/50">
									<button
										onClick={
											handleViewAll
										}
										className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-surface hover:bg-surface-raised text-text-secondary hover:text-text-primary transition-colors text-sm font-medium"
									>
										<span>
											View all{" "}
											{
												currentData.length
											}{" "}
											{tabs
												.find(
													(
														t
													) =>
														t.id ===
														activeTab
												)
												?.label.toLowerCase()}
										</span>
										<ArrowRight
											size={14}
										/>
									</button>
								</div>
							)}
						</div>

						<NoteManager clientId={client.id} />
						<ChangeHistory scope={{kind: "entity", type: "client", id: clientId ?? ""} }/>
					</div>

					{/* RIGHT COLUMN */}
					<div className="flex flex-col gap-4 lg:gap-5 min-w-0 xl:w-full order-1 xl:order-2">
						<ClientDisputesCard clientId={client.id} />
						<Card title="Client Information">
							<div className="space-y-3">
								<div>
									<div className="text-[10px] uppercase font-semibold text-text-muted tracking-wide mb-1">
										Address
									</div>
									<div className="text-sm text-text-primary break-words">
										{client.address}
									</div>
								</div>
								<div className="grid grid-cols-2 gap-3 sm:gap-4">
									<div>
										<div className="text-[10px] uppercase font-semibold text-text-muted tracking-wide mb-1">
											Created
										</div>
										<div className="text-sm text-text-primary">
											{formatDate(
												client.created_at
											)}
										</div>
									</div>
									<div>
										<div className="text-[10px] uppercase font-semibold text-text-muted tracking-wide mb-1">
											Last
											Activity
										</div>
										<div className="text-sm text-text-primary">
											{new Date(
												client.last_activity
											).toLocaleDateString(
												"en-US",
												{
													month: "short",
													day: "numeric",
													year: "numeric",
													hour: "numeric",
													minute: "2-digit",
												}
											)}
										</div>
									</div>
								</div>
							</div>
						</Card>

						<ContactManager clientId={client.id} />
					</div>
				</div>

				<EditClientModal
					isOpen={isEditModalOpen}
					onClose={() => setIsEditModalOpen(false)}
					client={client}
				/>
			</div>
		</div>
	);
}
