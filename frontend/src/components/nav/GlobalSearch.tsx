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
import { useAllClientsQuery } from "../../hooks/useClients";
import { useAllRequestsQuery } from "../../hooks/useRequests";
import { useAllQuotesQuery } from "../../hooks/useQuotes";
import { useAllJobsQuery, useAllJobVisitsQuery } from "../../hooks/useJobs";
import { useAllRecurringPlansQuery } from "../../hooks/useRecurringPlans";
import { useActiveTechniciansQuery } from "../../hooks/useTechnicians";

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
const MAX_RESULTS = 200;

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

function matches(value: string | null | undefined, q: string): boolean {
	if (!value) return false;
	return value.toLowerCase().includes(q);
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

	const { data: clients, isLoading: loadingClients } = useAllClientsQuery();
	const { data: requests, isLoading: loadingRequests } = useAllRequestsQuery();
	const { data: quotes, isLoading: loadingQuotes } = useAllQuotesQuery();
	const { data: jobs, isLoading: loadingJobs } = useAllJobsQuery();
	const { data: visits, isLoading: loadingVisits } = useAllJobVisitsQuery();
	const { data: plans, isLoading: loadingPlans } = useAllRecurringPlansQuery();
	const { data: technicians, isLoading: loadingTechnicians } = useActiveTechniciansQuery();

	const isLoading =
		loadingClients ||
		loadingRequests ||
		loadingQuotes ||
		loadingJobs ||
		loadingVisits ||
		loadingPlans ||
		loadingTechnicians;

	const results = useMemo<SearchResult[]>(() => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [];

		const out: SearchResult[] = [];

		for (const c of clients ?? []) {
			if (matches(c.name, q)) {
				out.push({
					id: c.id,
					type: "Client",
					primary: c.name,
					route: `/dispatch/clients/${c.id}`,
				});
			}
			if (out.length >= MAX_RESULTS) break;
		}

		for (const r of requests ?? []) {
			if (out.length >= MAX_RESULTS) break;
			if (matches(r.title, q) || matches(r.client?.name, q)) {
				out.push({
					id: r.id,
					type: "Request",
					primary: r.title,
					secondary: r.client?.name,
					route: `/dispatch/requests/${r.id}`,
				});
			}
		}

		for (const q_ of quotes ?? []) {
			if (out.length >= MAX_RESULTS) break;
			if (
				matches(q_.title, q) ||
				matches(q_.quote_number, q) ||
				matches(q_.client?.name, q)
			) {
				const primary = q_.quote_number
					? `${q_.quote_number}${q_.title ? ` · ${q_.title}` : ""}`
					: (q_.title ?? q_.quote_number ?? "Quote");
				out.push({
					id: q_.id,
					type: "Quote",
					primary,
					secondary: q_.client?.name,
					route: `/dispatch/quotes/${q_.id}`,
				});
			}
		}

		for (const j of jobs ?? []) {
			if (out.length >= MAX_RESULTS) break;
			if (
				matches(j.name, q) ||
				matches(j.job_number, q) ||
				matches(j.client?.name, q)
			) {
				const primary = j.job_number
					? `${j.job_number} · ${j.name}`
					: j.name;
				out.push({
					id: j.id,
					type: "Job",
					primary,
					secondary: j.client?.name,
					route: `/dispatch/jobs/${j.id}`,
				});
			}
		}

		for (const v of visits ?? []) {
			if (out.length >= MAX_RESULTS) break;
			const visName = v.name ?? v.job?.name ?? "";
			const clientName = v.job?.client?.name;
			if (
				matches(visName, q) ||
				matches(v.job?.name, q) ||
				matches(clientName, q)
			) {
				const secondary = [clientName, formatDate(v.scheduled_start_at)]
					.filter(Boolean)
					.join(" · ");
				out.push({
					id: v.id,
					type: "Visit",
					primary: visName,
					secondary,
					route: `/dispatch/jobs/${v.job_id}/visits/${v.id}`,
				});
			}
		}

		for (const p of plans ?? []) {
			if (out.length >= MAX_RESULTS) break;
			if (matches(p.name, q) || matches(p.client?.name, q)) {
				out.push({
					id: p.id,
					type: "Recurring Plan",
					primary: p.name,
					secondary: p.client?.name,
					route: `/dispatch/recurring-plans/${p.id}`,
				});
			}
		}

		for (const t of technicians ?? []) {
			if (out.length >= MAX_RESULTS) break;
			if (matches(t.name, q) || matches(t.email, q)) {
				out.push({
					id: t.id,
					type: "Technician",
					primary: t.name,
					secondary: t.email ?? undefined,
					route: `/dispatch/technicians/${t.id}`,
				});
			}
		}

		return out;
	}, [query, clients, requests, quotes, jobs, visits, plans, technicians]);

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
						{results.length === 0 ? (
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
							{results.length >= MAX_RESULTS
								? `${MAX_RESULTS}+ results`
								: `${results.length} result${results.length !== 1 ? "s" : ""}`}
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
