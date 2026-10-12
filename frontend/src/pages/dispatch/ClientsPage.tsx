import { useState, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, MoreVertical, Upload, Download } from "lucide-react";
import { useAllClientsQuery, useCreateClientMutation } from "../../hooks/useClients";
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
import PageReportSection from "../../components/reports/PageReportSection";

export default function ClientsPage() {
	const [pageSearchParams, setPageSearchParams] = useSearchParams();
	const {
		data: clients,
		isLoading: isFetchLoading,
		error: fetchError,
	} = useAllClientsQuery();
	const { mutateAsync: createClient } = useCreateClientMutation();
	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const [viewMode, setViewMode] = useState<"card" | "list">("card");
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [showActionsMenu, setShowActionsMenu] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	//permissions
	const CREATE_CLIENT = usePermission("create_clients");

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

	const statusFilter = pageSearchParams.get("status");

	const clearStatus = () => {
		const next = new URLSearchParams(pageSearchParams);
		next.delete("status");
		setPageSearchParams(next);
	};

	const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

	const filteredClients = clients
		?.filter((c) => {
			if (activeTerms.length > 0) {
				const matches = activeTerms.every((t) => {
					const lower = t.toLowerCase();
					return (
						c.name.toLowerCase().includes(lower) ||
						(c.address?.toLowerCase().includes(lower) ?? false)
					);
				});
				if (!matches) return false;
			}
			if (statusFilter === "active") return c.is_active === true;
			if (statusFilter === "inactive") return c.is_active === false;
			return true;
		})
		.sort((a, b) => {
			if (a.is_active === b.is_active) return 0;
			return a.is_active ? -1 : 1;
		});

	return (
		<div className="text-text-primary">
			<PageHeader title="Clients">
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

			<PageReportSection page="clients" label="Clients report" />

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
					<StatusFilter
						paramKey="status"
						placeholder="Status"
						options={[
							{ value: "active", label: "Active" },
							{ value: "inactive", label: "Inactive" },
						]}
					/>
				}
				right={<ViewToggle value={viewMode} onChange={setViewMode} />}
			/>

			{/* Single Filter Bar with Chips */}
			<FilterChips
				filters={[
					statusFilter
						? {
								label: `Status: ${statusFilter === "active" ? "Active" : "Inactive"}`,
								color: "green" as const,
								onRemove: clearStatus,
						  }
						: null,
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
				]}
				resultCount={filteredClients?.length ?? 0}
				onClearAll={() => {
					setSearchInput("");
					const next = new URLSearchParams(pageSearchParams);
					next.delete("search");
					next.delete("status");
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
			{!isFetchLoading && !fetchError && filteredClients?.length === 0 && (
				<div className="w-full h-[400px] flex flex-col justify-center items-center">
					<BoxSvg className="w-15 h-15 mb-1" />
					<h1 className="text-center text-xl mt-1">
						{activeTerms.length > 0
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
				filteredClients &&
				filteredClients.length > 0 && (
					<div
						className={
							viewMode === "card"
								? "grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]"
								: "flex flex-col gap-2"
						}
					>
						{filteredClients.map((client) => (
							<ClientCard
								key={client.id}
								client={client}
								viewMode={viewMode}
								to={`/dispatch/clients/${client.id}`}
							/>
						))}
					</div>
				)}

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
