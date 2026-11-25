import { useState, useRef, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, MoreVertical, Upload, Download } from "lucide-react";
import { useCreateClientMutation } from "../../hooks/useClients";
import { getClientsPage, type ClientListExtras } from "../../api/clients";
import { usePagedList } from "../../hooks/usePagedList";
import { useListPaging } from "../../hooks/useListPaging";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { qk } from "../../lib/queryKeys";
import ReportPagination from "../../components/reports/ReportPagination";
import type { ListParams } from "../../types/paging";
import CreateClient from "../../components/clients/CreateClient";
import ClientCard from "../../components/clients/ClientCard";
import LoadSvg from "../../assets/icons/loading.svg?react";
import BoxSvg from "../../assets/icons/box.svg?react";
import ErrSvg from "../../assets/icons/error.svg?react";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import ViewToggle from "../../components/ui/ViewToggle";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import PageHeader from "../../components/ui/PageHeader";
import { usePermission } from "../../hooks/usePermission";
import PageReportButton from "../../components/reports/PageReportButton";
import PageReportKpis from "../../components/reports/PageReportKpis";
import { usePageReport } from "../../components/reports/usePageReport";

const STATUS_LABELS: Record<string, string> = { active: "Active", inactive: "Inactive" };
const TAX_LABELS: Record<string, string> = { exempt: "Exempt", taxable: "Taxable" };

// Repeated (?status=a&status=b, what the filter writes) or comma-joined; values the
// server would refuse (an old bookmark) are dropped rather than sent.
const knownValues = (sp: URLSearchParams, key: string, known: Record<string, string>) =>
	sp.getAll(key).flatMap((v) =>
		v
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s in known)
	);

export default function ClientsPage() {
	const [pageSearchParams, setPageSearchParams] = useSearchParams();
	const { mutateAsync: createClient } = useCreateClientMutation();
	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const { removeTerm: removeStatus } = useMultiSearch("status");
	const { removeTerm: removeTax } = useMultiSearch("tax");
	const [viewMode, setViewMode] = useState<"card" | "list">("card");
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [showActionsMenu, setShowActionsMenu] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	//permissions
	const CREATE_CLIENT = usePermission("create_clients");
	const report = usePageReport("clients", "Clients report");

	useEffect(() => {
		const handleOutsideClick = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setShowActionsMenu(false);
			}
		};
		if (showActionsMenu) {
			document.addEventListener("mousedown", handleOutsideClick);
			return () => document.removeEventListener("mousedown", handleOutsideClick);
		}
	}, [showActionsMenu]);

	const statusFilter = knownValues(pageSearchParams, "status", STATUS_LABELS);
	// Same split as the report popover's Tax Status breakdown, so its slices drill here.
	const taxFilter = knownValues(pageSearchParams, "tax", TAX_LABELS);

	const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
	// Chips and the text being typed go to the server as one string it splits into words.
	const q = useDebouncedValue([...terms, searchInput.trim()].filter(Boolean).join(" "));

	// Both values (or none) is no filter, so only a lone value is sent.
	const tax = taxFilter.length === 1 ? (taxFilter[0] as ClientListExtras["tax"]) : undefined;
	const filters = useMemo(
		() => ({
			q: q || undefined,
			status: statusFilter.length ? statusFilter : undefined,
			tax,
		}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[q, statusFilter.join(","), tax]
	);

	const { page, limit, paginationProps } = useListPaging(filters);
	const params: ListParams = { page, limit, q: filters.q, status: filters.status };
	const {
		data,
		isLoading: isFetchLoading,
		isFetching,
		error: fetchError,
	} = usePagedList(
		[...qk.clients.list(), { tax }],
		(p) => getClientsPage(p, { tax }),
		params
	);
	const clients = data?.rows;
	const total = data?.total ?? 0;

	return (
		<div className="text-text-primary">
			<PageHeader title="Clients" subtitle={<PageReportKpis report={report} />}>
				<PageReportButton report={report} />
					<button
						title={!CREATE_CLIENT ? "You don't have permission to perform this action" : undefined}
						className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						onClick={() => setIsModalOpen(true)}
						disabled={!CREATE_CLIENT}
					>
						<Plus size={16} />
						New Client
					</button>
				<div className="relative" ref={menuRef}>
					<button
						onClick={() => setShowActionsMenu(!showActionsMenu)}
						aria-label="More actions"
						aria-expanded={showActionsMenu}
						aria-haspopup="menu"
						className="flex items-center justify-center p-2.5 hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong"
					>
						<MoreVertical size={20} className="text-text-secondary" />
					</button>
					{showActionsMenu && (
						<div className="absolute right-0 mt-2 w-56 bg-canvas border border-border-strong rounded-lg shadow-2xl shadow-black/50 z-50">
							<div className="py-1">
								<div className="px-4 py-2 text-xs text-text-muted italic border-b border-border-subtle mb-1">
									Options yet to be
									implemented
								</div>
								<button
									onClick={() =>
										setShowActionsMenu(
											false
										)
									}
									className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2"
								>
									<Upload size={16} />
									Import Clients
								</button>
								<button
									onClick={() =>
										setShowActionsMenu(
											false
										)
									}
									className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2"
								>
									<Download size={16} />
									Export Clients
								</button>
							</div>
						</div>
					)}
				</div>
			</PageHeader>


			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search clients..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				middle={
					<div className="flex items-center gap-2">
						<StatusFilter
							paramKey="status"
							placeholder="Status"
							options={[
								{ value: "active", label: "Active" },
								{ value: "inactive", label: "Inactive" },
							]}
						/>
						<StatusFilter
							paramKey="tax"
							placeholder="Tax status"
							options={[
								{ value: "exempt", label: "Exempt" },
								{ value: "taxable", label: "Taxable" },
							]}
						/>
					</div>
				}
				right={<ViewToggle value={viewMode} onChange={setViewMode} />}
			/>

			{/* Single Filter Bar with Chips */}
			<FilterChips
				filters={[
					...statusFilter.map((s) => ({
						label: `Status: ${STATUS_LABELS[s]}`,
						color: "green" as const,
						onRemove: () => removeStatus(s),
					})),
					...taxFilter.map((t) => ({
						label: `Tax: ${TAX_LABELS[t]}`,
						color: "blue" as const,
						onRemove: () => removeTax(t),
					})),
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
				]}
				resultCount={total}
				onClearAll={() => {
					setSearchInput("");
					const next = new URLSearchParams(pageSearchParams);
					next.delete("search");
					next.delete("status");
					next.delete("tax");
					setPageSearchParams(next);
				}}
			/>

			{/* Loading State */}
			{isFetchLoading && (
				<div className="w-full h-[400px] flex flex-col justify-center items-center">
					<LoadSvg className="w-12 h-12 mb-3" />
					<h1 className="text-center text-xl mt-3">Please wait...</h1>
				</div>
			)}

			{/* Error State */}
			{fetchError && !isFetchLoading && (
				<div className="w-full h-[400px] flex flex-col justify-center items-center">
					<ErrSvg className="w-15 h-15 mb-1" />
					<h1 className="text-center text-xl mt-1">
						An error has occurred.
					</h1>
					<h2 className="text-center text-text-muted mt-1">
						{fetchError.message}
					</h2>
				</div>
			)}

			{/* Empty State */}
			{!isFetchLoading && !fetchError && clients?.length === 0 && (
				<div className="w-full h-[400px] flex flex-col justify-center items-center">
					<BoxSvg className="w-15 h-15 mb-1" />
					<h1 className="text-center text-xl mt-1">
						{activeTerms.length > 0 || statusFilter.length > 0 || taxFilter.length > 0
							? "No clients found."
							: "No clients yet."}
					</h1>
					{activeTerms.length > 0 && (
						<p className="text-center text-text-muted mt-2">
							Try adjusting your search terms
						</p>
					)}
				</div>
			)}

			{/* Client Cards */}
			{!isFetchLoading &&
				!fetchError &&
				clients &&
				clients.length > 0 && (
					<div
						className={
							viewMode === "card"
								? "grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]"
								: "flex flex-col gap-2"
						}
					>
						{clients.map((client) => (
							<ClientCard
								key={client.id}
								client={client}
								viewMode={viewMode}
								to={`/dispatch/clients/${client.id}`}
							/>
						))}
					</div>
				)}

			<ReportPagination {...paginationProps(total, isFetching)} />

			<CreateClient
				isModalOpen={isModalOpen}
				setIsModalOpen={setIsModalOpen}
				createClient={async (input) => {
					const newClient = await createClient(input);

					if (!newClient?.id)
						throw new Error(
							"Client creation failed: no ID returned"
						);

					return newClient.id;
				}}
			/>
		</div>
	);
}
