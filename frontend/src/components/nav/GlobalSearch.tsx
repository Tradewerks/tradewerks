import { useState, useRef, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
	Search,
	Users,
	Phone,
	FileText,
	Briefcase,
	CalendarCheck,
	Repeat,
	Wrench,
	ChevronLeft,
	ChevronRight,
	Loader2,
} from "lucide-react";
import { useSearchQuery } from "../../hooks/useSearch";
import type { SearchEntityType, SearchHit } from "../../api/search";

// ─── Types ────────────────────────────────────────────────────────────────────

type EntityType =
	| "Client"
	| "Request"
	| "Quote"
	| "Job"
	| "Visit"
	| "Recurring Plan"
	| "Technician";

interface SearchResult {
	id: string;
	type: EntityType;
	primary: string;
	secondary?: string;
	route: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;
// Per type; the server caps this at 50.
const PER_TYPE_LIMIT = 25;

const ENTITY_ICONS: Record<EntityType, React.ReactNode> = {
	Client: <Users size={16} />,
	Request: <Phone size={16} />,
	Quote: <FileText size={16} />,
	Job: <Briefcase size={16} />,
	Visit: <CalendarCheck size={16} />,
	"Recurring Plan": <Repeat size={16} />,
	Technician: <Wrench size={16} />,
};

const ENTITY_BADGE_COLORS: Record<EntityType, string> = {
	Client: "bg-primary/10 text-primary-text border-primary/30",
	Request: "bg-warning-bg text-warning-text border-warning-border",
	Quote: "bg-reviewing-bg text-reviewing-text border-reviewing-border",
	Job: "bg-success-bg text-success-text border-success-border",
	Visit: "bg-info-bg text-info-text border-info-border",
	"Recurring Plan": "bg-orange-bg text-orange-text border-orange-border",
	Technician: "bg-surface-raised text-text-tertiary border-border-strong",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Server types the dropdown surfaces, in display order. A type the caller can't
// see (permission or module off) simply comes back empty.
const SEARCH_TYPES: SearchEntityType[] = [
	"client",
	"request",
	"quote",
	"job",
	"visit",
	"recurring_plan",
	"technician",
];

const HIT_ENTITY: Partial<Record<SearchEntityType, EntityType>> = {
	client: "Client",
	request: "Request",
	quote: "Quote",
	job: "Job",
	visit: "Visit",
	recurring_plan: "Recurring Plan",
	technician: "Technician",
};

// The server joins a visit's start time into its sublabel as an ISO string.
const ISO_TAIL = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

function toResult(hit: SearchHit): SearchResult | null {
	const type = HIT_ENTITY[hit.type];
	if (!type) return null;
	let secondary = hit.sublabel;
	if (hit.type === "visit" && secondary) {
		secondary = secondary
			.split(" · ")
			.map((part) => (ISO_TAIL.test(part) ? formatDate(part) : part))
			.join(" · ");
	}
	return { id: hit.id, type, primary: hit.label, secondary, route: hit.route };
}

function formatDate(dateStr: Date | string): string {
	const d = new Date(dateStr);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GlobalSearch() {
	const navigate = useNavigate();

	const [query, setQuery] = useState("");
	const [isOpen, setIsOpen] = useState(false);
	const [page, setPage] = useState(0);

	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const search = useSearchQuery(query, { types: SEARCH_TYPES, limit: PER_TYPE_LIMIT });
	const isLoading = search.isFetching || search.isSettling;

	const results = useMemo<SearchResult[]>(() => {
		if (query.trim().length < 2) return [];
		const order = (t: SearchEntityType) => SEARCH_TYPES.indexOf(t);
		return [...(search.data?.hits ?? [])]
			.sort((a, b) => order(a.type) - order(b.type))
			.map(toResult)
			.filter((r): r is SearchResult => r !== null);
	}, [query, search.data]);
	const truncated = search.data?.truncated ?? false;

	// ── Pagination ────────────────────────────────────────────────────────────
	const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
	const pageResults = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	// Reset page on query change
	useEffect(() => {
		setPage(0);
	}, [query]);

	// ── Outside click / Escape ─────────────────────────────────────────────
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setIsOpen(false);
			}
		};
		const keyHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setIsOpen(false);
		};
		document.addEventListener("mousedown", handler);
		document.addEventListener("keydown", keyHandler);
		return () => {
			document.removeEventListener("mousedown", handler);
			document.removeEventListener("keydown", keyHandler);
		};
	}, []);

	// ── Handlers ──────────────────────────────────────────────────────────────
	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value;
		setQuery(val);
		setIsOpen(val.trim().length >= 2);
	};

	const handleFocus = () => {
		if (query.trim().length >= 2) setIsOpen(true);
	};

	const handleSelect = (route: string) => {
		setIsOpen(false);
		setQuery("");
		navigate(route);
	};

	const showDropdown = isOpen && query.trim().length >= 2;

	return (
		<div ref={containerRef} className="relative w-64 lg:w-80">
			{/* Input */}
			<Search
				size={16}
				className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
			/>
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={handleInputChange}
				onFocus={handleFocus}
				placeholder="Search..."
				className="w-full pl-9 pr-3 py-2 rounded-md bg-surface border border-border text-sm text-text-primary placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-primary-border"
			/>
			{isLoading && query.trim().length >= 2 && (
				<Loader2
					size={14}
					className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary animate-spin"
				/>
			)}

			{/* Dropdown */}
			{showDropdown && (
				<div className="absolute top-full mt-1 left-0 w-full bg-base border border-border rounded-md shadow-xl z-50 flex flex-col overflow-hidden">
					{/* Results list */}
					<div>
						{search.isError ? (
							<div className="px-4 py-6 text-center text-text-muted text-sm">
								Search is unavailable. Try again.
							</div>
						) : results.length === 0 && isLoading ? (
							<div className="px-4 py-6 text-center text-text-muted text-sm">
								Searching...
							</div>
						) : results.length === 0 ? (
							<div className="px-4 py-6 text-center text-text-muted text-sm">
								No results found
							</div>
						) : (
							pageResults.map((result) => (
								<button
									key={`${result.type}-${result.id}`}
									onClick={() =>
										handleSelect(
											result.route
										)
									}
									className="flex items-center gap-3 px-3 py-2 hover:bg-surface w-full text-left transition-colors border-b border-border-subtle last:border-b-0"
								>
									{/* Icon */}
									<span className="text-text-tertiary flex-shrink-0">
										{
											ENTITY_ICONS[
												result
													.type
											]
										}
									</span>

									{/* Text */}
									<span className="flex-1 min-w-0">
										<span className="block text-sm font-medium text-text-primary truncate">
											{
												result.primary
											}
										</span>
										{result.secondary && (
											<span className="block text-xs text-text-tertiary truncate">
												{
													result.secondary
												}
											</span>
										)}
									</span>

									{/* Type badge */}
									<span
										className={`flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${ENTITY_BADGE_COLORS[result.type]}`}
									>
										{result.type}
									</span>
								</button>
							))
						)}
					</div>

					{/* Footer */}
					<div className="flex items-center justify-between px-3 py-2 border-t border-border bg-base text-xs text-text-tertiary flex-shrink-0">
						<span>
							{`${results.length}${truncated ? "+" : ""} result${results.length !== 1 ? "s" : ""}`}
						</span>
						<span className="mx-2">
							Page {page + 1} / {totalPages}
						</span>
						<div className="flex items-center gap-1">
							<button
								onClick={() =>
									setPage((p) =>
										Math.max(0, p - 1)
									)
								}
								disabled={page === 0}
								className="p-0.5 rounded hover:bg-surface-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
							>
								<ChevronLeft size={14} />
							</button>
							<button
								onClick={() =>
									setPage((p) =>
										Math.min(
											totalPages -
												1,
											p + 1
										)
									)
								}
								disabled={page >= totalPages - 1}
								className="p-0.5 rounded hover:bg-surface-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
							>
								<ChevronRight size={14} />
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
