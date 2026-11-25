import { useState, useMemo, useCallback, useEffect } from "react";
import { Search, X, BookOpen, Check, ChevronRight, Users, Trash2 } from "lucide-react";

export interface TemplateSearchClient {
	id: string;
	name: string;
}

export interface TemplateSearchResult {
	id: string;
	title: string;
	subtitle?: string;
	detail?: string;
	badge?: string;
	badgeColor?: string;
	value?: string;
	createdAt?: string;
	clientId?: string;
	clientName?: string;
	/** When true, a delete button is rendered on this row */
	isDeletable?: boolean;
}

export interface TemplateSearchScopeToggle {
	thisLabel: string;
	anyLabel: string;
	isThisScope: boolean;
	onToggle: () => void;
}

interface TemplateSearchProps {
	heading?: string;
	headingHint?: string;
	placeholder?: string;
	results: TemplateSearchResult[];
	clients: TemplateSearchClient[];
	isLoading?: boolean;
	onSelect: (id: string) => void;
	onClose: () => void;
	onDelete?: (id: string) => void;
	isDeletingId?: string | null;
	scopeToggle?: TemplateSearchScopeToggle;
	clientFilter?: string;
	onClientFilterChange?: (clientId: string) => void;
	selectedIds?: readonly string[];
	onToggleSelect?: (id: string) => void;
	emptyHint?: string;
	// For a caller whose results come from a server search: the typed text.
	onQueryChange?: (query: string) => void;
	// Same for the client filter: `clients` is then the server's suggestions for the
	// typed text, so the filter shows even while that list is empty.
	onClientQueryChange?: (query: string) => void;
}

function DeleteButton({
	id,
	onDelete,
	isDeleting,
}: {
	id: string;
	onDelete: (id: string) => void;
	isDeleting: boolean;
}) {
	const [armed, setArmed] = useState(false);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation(); // don't trigger row select
			if (armed) {
				onDelete(id);
				setArmed(false);
			} else {
				setArmed(true);
			}
		},
		[armed, id, onDelete]
	);

	const handleBlur = useCallback(() => {
		// Small delay so a rapid second click still lands before reset
		setTimeout(() => setArmed(false), 150);
	}, []);

	return (
		<button
			type="button"
			onClick={handleClick}
			onBlur={handleBlur}
			disabled={isDeleting}
			title={armed ? "Click again to confirm delete" : "Delete draft"}
			className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded transition-colors ${
				isDeleting
					? "text-text-faint cursor-not-allowed"
					: armed
						? "text-error-text bg-error-bg border border-error-border hover:bg-error-bg"
						: "text-text-muted hover:text-error-text hover:bg-surface-raised border border-transparent"
			}`}
		>
			<Trash2 size={12} className={isDeleting ? "animate-pulse" : ""} />
		</button>
	);
}

export function TemplateSearch({
	heading = "Start from existing",
	headingHint = "— select one to pre-fill the form",
	placeholder = "Search by title, number, description...",
	results,
	clients,
	isLoading = false,
	onSelect,
	onDelete,
	isDeletingId = null,
	scopeToggle,
	clientFilter: controlledClientFilter,
	onClientFilterChange,
	selectedIds,
	onToggleSelect,
	emptyHint = "No existing entries to use as a template",
	onQueryChange,
	onClientQueryChange,
}: TemplateSearchProps) {
	const isMultiSelect = selectedIds !== undefined;
	const selectedSet = useMemo(
		() => new Set(selectedIds ?? []),
		[selectedIds]
	);
	const [query, setQuery] = useState("");
	const [clientQuery, setClientQuery] = useState("");
	useEffect(() => {
		onQueryChange?.(query);
	}, [query, onQueryChange]);
	useEffect(() => {
		onClientQueryChange?.(clientQuery);
	}, [clientQuery, onClientQueryChange]);
	// A server-searched `clients` list narrows as the text changes, so the picked
	// client's name is kept from the moment of the pick.
	const [pickedClient, setPickedClient] = useState<TemplateSearchClient | null>(null);

	// Uncontrolled fallback — used when parent does not pass clientFilter props
	const [internalClientFilter, setInternalClientFilter] = useState("");

	const isControlled =
		controlledClientFilter !== undefined && onClientFilterChange !== undefined;
	const clientFilter = isControlled ? controlledClientFilter : internalClientFilter;
	const setClientFilter = useCallback(
		(id: string) => {
			if (isControlled) {
				onClientFilterChange!(id);
			} else {
				setInternalClientFilter(id);
			}
		},
		[isControlled, onClientFilterChange]
	);

	const filteredClients = useMemo(() => {
		const q = clientQuery.toLowerCase().trim();
		// A server-searched list is already the match for what was typed.
		if (!q || onClientQueryChange) return clients;
		return clients.filter((c) => c.name.toLowerCase().includes(q));
	}, [clients, clientQuery, onClientQueryChange]);

	const activeClientName = useMemo(
		() =>
			clients.find((c) => c.id === clientFilter)?.name ??
			(pickedClient?.id === clientFilter ? pickedClient.name : ""),
		[clients, clientFilter, pickedClient]
	);

	const filtered = useMemo(() => {
		const q = query.toLowerCase().trim();
		return results.filter((r) => {
			if (clientFilter && r.clientId !== clientFilter) return false;
			if (!q) return true;
			return (
				r.title.toLowerCase().includes(q) ||
				r.subtitle?.toLowerCase().includes(q) ||
				r.detail?.toLowerCase().includes(q) ||
				r.clientName?.toLowerCase().includes(q)
			);
		});
	}, [results, query, clientFilter]);

	const clearClientFilter = () => {
		setClientFilter("");
		setClientQuery("");
	};

	return (
		<div className="flex flex-col">
			{/* -- Header -- */}
			<div className="flex-shrink-0 space-y-2 pb-2 border-b border-border-subtle">
				{/* Row 1: heading */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2 min-w-0">
						<div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
							<BookOpen
								size={14}
								className="text-primary-text"
							/>
						</div>
						<h3 className="text-sm font-semibold text-primary">
							{heading}
						</h3>
						<span className="text-xs text-text-muted font-normal hidden sm:inline">
							{headingHint}
						</span>
					</div>
				</div>

				{/* Row 2: search + scope toggle + client filter */}
				<div className="flex gap-2">
					<div className="relative flex-1 min-w-0">
						<Search
							size={14}
							className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
						/>
						<input
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={placeholder}
							autoFocus
							className="w-full h-[34px] pl-8 pr-8 bg-base border border-border rounded text-sm text-primary placeholder:text-faint focus:border-primary focus:outline-none transition-colors"
						/>
						{query && (
							<button
								type="button"
								onClick={() => setQuery("")}
								className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
							>
								<X size={12} />
							</button>
						)}
					</div>

					{scopeToggle && (
						<button
							type="button"
							onClick={scopeToggle.onToggle}
							className={`flex-shrink-0 h-[34px] px-3 rounded text-xs font-medium border transition-colors ${
								scopeToggle.isThisScope
									? "bg-primary/15 border-primary/40 text-primary-text hover:bg-primary/25"
									: "bg-surface border-border text-text-tertiary hover:text-text-primary hover:border-border-strong"
							}`}
							title={
								scopeToggle.isThisScope
									? "Showing this job only — click to show all jobs"
									: "Showing all jobs — click to show this job only"
							}
						>
							{scopeToggle.isThisScope
								? scopeToggle.thisLabel
								: scopeToggle.anyLabel}
						</button>
					)}

					{(clients.length > 0 || onClientQueryChange) &&
						(!scopeToggle || !scopeToggle.isThisScope) && (
							<div className="relative flex-shrink-0 w-44">
								{clientFilter ? (
									<div className="flex items-center h-[34px] px-2.5 gap-1.5 bg-primary/10 border border-primary/30 rounded text-xs text-primary-text font-medium">
										<Users
											size={12}
											className="flex-shrink-0 text-primary-text"
										/>
										<span className="truncate flex-1 min-w-0">
											{
												activeClientName
											}
										</span>
										<button
											type="button"
											onClick={
												clearClientFilter
											}
											className="flex-shrink-0 text-primary-text hover:text-text-primary transition-colors"
											title="Clear client filter"
										>
											<X
												size={
													12
												}
											/>
										</button>
									</div>
								) : (
									<>
										<Users
											size={14}
											className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
										/>
										<input
											type="text"
											value={
												clientQuery
											}
											onChange={(
												e
											) =>
												setClientQuery(
													e
														.target
														.value
												)
											}
											placeholder="Filter by client…"
											className="w-full h-[34px] pl-8 pr-2 bg-base border border-border rounded text-sm text-primary placeholder:text-faint focus:border-primary focus:outline-none transition-colors"
										/>
										{clientQuery &&
											filteredClients.length >
												0 && (
												<div className="absolute top-full left-0 right-0 mt-1 bg-base border border-border rounded shadow-xl z-20 max-h-48 overflow-y-auto">
													{filteredClients.map(
														(
															c
														) => (
															<button
																key={
																	c.id
																}
																type="button"
																onClick={() => {
																	setPickedClient(c);
																	setClientFilter(
																		c.id
																	);
																	setClientQuery(
																		""
																	);
																}}
																className="w-full flex items-center px-3 py-2 text-sm text-text-primary hover:bg-surface hover:text-text-primary transition-colors text-left"
															>
																{
																	c.name
																}
															</button>
														)
													)}
												</div>
											)}
										{clientQuery &&
											filteredClients.length ===
												0 && (
												<div className="absolute top-full left-0 right-0 mt-1 bg-base border border-border rounded shadow-xl z-20 px-3 py-2 text-xs text-text-muted">
													No
													clients
													found
												</div>
											)}
									</>
								)}
							</div>
						)}
				</div>
			</div>

			{/* -- Results -- */}
			<div className="overflow-y-auto space-y-1 pt-2 pb-2 max-h-[55vh]">
				{isLoading ? (
					<div className="flex items-center justify-center py-10 text-text-muted text-sm">
						Loading...
					</div>
				) : filtered.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-10 text-center">
						<Search size={24} className="text-text-faint mb-2" />
						<p className="text-sm text-text-tertiary font-medium">
							No results found
						</p>
						<p className="text-xs text-text-faint mt-1">
							{query || clientFilter
								? "Try adjusting your search or filter"
								: emptyHint}
						</p>
					</div>
				) : (
					filtered.map((r) => {
						const isSelected = selectedSet.has(r.id);
						return (
						<div
							key={r.id}
							className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-all ${
								isSelected
									? "border-primary bg-primary/10"
									: "border-transparent hover:border-border hover:bg-surface/60"
							}`}
						>
							{/* Main clickable area */}
							<button
								type="button"
								onClick={() =>
									isMultiSelect
										? onToggleSelect?.(r.id)
										: onSelect(r.id)
								}
								aria-pressed={
									isMultiSelect ? isSelected : undefined
								}
								className="flex items-center gap-3 flex-1 min-w-0 text-left"
							>
								<div
									className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 transition-colors ${
										isSelected
											? "bg-primary border-primary"
											: "bg-surface border-border group-hover:border-border-strong"
									}`}
								>
									{isMultiSelect ? (
										isSelected ? (
											<Check
												size={14}
												className="text-on-primary"
											/>
										) : null
									) : (
										<BookOpen
											size={14}
											className="text-text-tertiary"
										/>
									)}
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 mb-0.5">
										<span className="text-sm font-medium text-primary truncate group-hover:text-text-primary-text transition-colors">
											{r.title}
										</span>
										{r.subtitle && (
											<span className="text-[10px] text-text-muted flex-shrink-0 font-mono">
												{
													r.subtitle
												}
											</span>
										)}
									</div>
									<div className="flex items-center gap-3 text-xs text-text-muted">
										{r.clientName && (
											<span className="truncate max-w-[140px]">
												{
													r.clientName
												}
											</span>
										)}
										{r.detail && (
											<span className="truncate max-w-[180px] text-text-faint">
												{
													r.detail
												}
											</span>
										)}
										{r.createdAt && (
											<span className="flex-shrink-0 tabular-nums">
												{new Date(
													r.createdAt
												).toLocaleDateString(
													"en-US",
													{
														month: "short",
														day: "numeric",
														year: "numeric",
													}
												)}
											</span>
										)}
									</div>
								</div>
								<div className="flex items-center gap-2 flex-shrink-0">
									{r.value && (
										<span className="text-sm font-semibold text-primary tabular-nums font-mono">
											{r.value}
										</span>
									)}
									{r.badge && (
										<span
											className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
												r.badgeColor ||
												"bg-surface-raised/50 text-text-tertiary border-border-strong"
											}`}
										>
											{r.badge}
										</span>
									)}
									{!isMultiSelect && (
										<ChevronRight
											size={14}
											className="text-text-faint group-hover:text-text-tertiary transition-colors"
										/>
									)}
								</div>
							</button>

							{r.isDeletable && onDelete && (
								<DeleteButton
									id={r.id}
									onDelete={onDelete}
									isDeleting={
										isDeletingId ===
										r.id
									}
								/>
							)}
						</div>
						);
					})
				)}
			</div>
		</div>
	);
}
