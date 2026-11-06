import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTaxGroups, useUpdateTaxGroup } from "../../../hooks/useTaxGroups";
import { formatCombinedRate } from "../../../types/tax";
import Dropdown from "../../ui/Dropdown";
import { errorMessage } from "../../../util/util";
import {
	activeDefaultGroup,
	defaultRowLabel,
	defaultRowNote,
	noDefaultWarning,
	type TaxMode,
} from "./taxSettingsCopy";

interface DefaultGroupRowProps {
	mode: TaxMode;
	legacyRate: number;
}

export default function DefaultGroupRow({ mode, legacyRate }: DefaultGroupRowProps) {
	// Active groups only, regardless of Show inactive: the resolver ignores an inactive default.
	const { data: groups, isLoading, error } = useTaxGroups(false);
	const update = useUpdateTaxGroup();
	const [picking, setPicking] = useState(false);
	// The choice in flight; shown instead of the server value until the save settles.
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const changeRef = useRef<HTMLButtonElement>(null);
	const pickerRef = useRef<HTMLSelectElement>(null);
	const wasPicking = useRef(false);

	const current = activeDefaultGroup(groups ?? []);

	// Change and the picker swap places, so focus has to follow whichever is mounted.
	useEffect(() => {
		if (picking) pickerRef.current?.focus();
		else if (wasPicking.current) changeRef.current?.focus();
		wasPicking.current = picking;
	}, [picking]);

	const close = () => {
		setPicking(false);
		setPendingId(null);
		setSaveError(null);
	};

	const choose = async (id: string) => {
		if (update.isPending) return;
		if (id === (current?.id ?? "")) return close();
		setSaveError(null);
		setPendingId(id);
		try {
			// Setting a new default clears the old one server-side, in the same transaction.
			await update.mutateAsync(
				id ? { id, data: { is_default: true } } : { id: current!.id, data: { is_default: false } },
			);
			close();
		} catch (err) {
			setPendingId(null);
			setSaveError(errorMessage(err, "Couldn't change the default group."));
		}
	};

	return (
		<div className="border-b border-border-subtle px-5 py-3">
			<p className="text-xs font-medium text-text-tertiary">{defaultRowLabel(mode)}</p>

			{isLoading ? (
				<div className="mt-1 flex h-7 items-center">
					<Loader2 size={14} className="animate-spin text-text-muted" />
				</div>
			) : error ? (
				<p className="mt-1 text-xs text-error-text">
					{errorMessage(error, "Couldn't load tax groups.")}
				</p>
			) : picking ? (
				<div
					className="mt-1 flex items-center gap-2"
					onKeyDown={(e) => {
						if (e.key === "Escape") close();
					}}
				>
					<div className="h-8 w-64 max-w-full rounded-md border border-border">
						<Dropdown
							aria-label="Default group"
							value={pendingId ?? current?.id ?? ""}
							refToApply={pickerRef}
							// Stays enabled while saving: a disabled select drops focus to <body>.
							onChange={(id) => void choose(id)}
							entries={[
								<option key="" value="">
									No default group
								</option>,
								...(groups ?? []).map((g) => (
									<option key={g.id} value={g.id}>
										{g.name} · {formatCombinedRate(g.combined_rate)}
									</option>
								)),
							]}
						/>
					</div>
					<button
						type="button"
						onClick={close}
						className="text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
					>
						Cancel
					</button>
				</div>
			) : (
				<div className="mt-1 flex items-center justify-between gap-3">
					<p
						className={`min-w-0 truncate text-sm ${current ? "text-text-primary" : "text-text-muted"}`}
					>
						{current
							? `${current.name} · ${formatCombinedRate(current.combined_rate)}`
							: "No group"}
					</p>
					<button
						ref={changeRef}
						type="button"
						onClick={() => setPicking(true)}
						className="flex-shrink-0 text-xs font-medium text-primary-text hover:underline"
					>
						Change
					</button>
				</div>
			)}

			{saveError && <p className="mt-1.5 text-xs text-error-text">{saveError}</p>}

			{!isLoading && !error && current && (
				<p className="mt-1 text-xs text-text-muted">{defaultRowNote(mode)}</p>
			)}

			{!isLoading && !error && !current && (
				<div className="mt-2 flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5">
					<AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-warning" />
					<p className="text-xs text-warning-text">{noDefaultWarning(mode, legacyRate)}</p>
				</div>
			)}
		</div>
	);
}
