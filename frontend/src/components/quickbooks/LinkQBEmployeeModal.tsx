import { useMemo, useState } from "react";
import {
	useLinkQBEmployeeMutation,
	useQBEmployeesQuery,
	useQBMappedEmployeesQuery,
} from "../../hooks/useQuickbooks";
import FullPopup from "../ui/FullPopup";
import { TemplateSearch, type TemplateSearchResult } from "../ui/forms/TemplateSearch";
import type { Technician } from "../../types/technicians";

interface LinkQBEmployeeModalProps {
	technician: Technician;
	onClose: () => void;
	isOpen: boolean;
}

export default function LinkQBEmployeeModal({ technician, onClose, isOpen }: LinkQBEmployeeModalProps) {
	const { data: qbEmployees, isLoading: employeesLoading } = useQBEmployeesQuery(isOpen);
	const { data: mappedEmployees } = useQBMappedEmployeesQuery(isOpen);
	const linkMutation = useLinkQBEmployeeMutation();
	const [selectedQbIds, setSelectedQbIds] = useState<string[]>([]);

	// Only offer QB employees that aren't already linked to some technician
	const availableQbEmployees = useMemo(() => {
		const mappedExternalIds = new Set((mappedEmployees ?? []).map((m) => m.external_id));
		return (qbEmployees ?? []).filter((q) => !mappedExternalIds.has(q.Id));
	}, [qbEmployees, mappedEmployees]);

	// Pre-select the backend's suggested match until the user picks one
	const suggestedQbId = availableQbEmployees.find((q) => q.suggestedTechnicianId === technician.id)?.Id;
	const selectedQbId = selectedQbIds[0] ?? suggestedQbId;

	const handleLink = async () => {
		if (!selectedQbId) return;
		try {
			await linkMutation.mutateAsync({ technician_id: technician.id, qb_employee_id: selectedQbId });
			setSelectedQbIds([]);
			onClose();
		} catch (error) {
			console.error("Error linking QuickBooks employee:", error);
		}
	};

	const templateResults = useMemo((): TemplateSearchResult[] => {
		return availableQbEmployees.map((i) => ({
			id: i.Id,
			title: i.DisplayName,
			subtitle: i.PrimaryEmailAddr?.Address,
		}));
	}, [availableQbEmployees]);

	const handleToggleSelect = (id: string) => {
		setSelectedQbIds([id]);
	}

	const content = (
		<div className="flex flex-col px-5 py-5">
			<h2 className="mb-1 text-lg font-semibold text-text-primary">Link to QuickBooks Employee</h2>
			<p className="mb-4 text-xs text-text-muted">
				Map <span className="font-medium text-text-secondary">{technician.name}</span> to an existing
				QuickBooks Employee.
			</p>

			<TemplateSearch
				heading="Link QB Employee"
				headingHint={`Select an employee to link to`}
				placeholder="Search employees by name or email…"
				results={templateResults}
				clients={[]}
				isLoading={employeesLoading}
				selectedIds={selectedQbId ? [selectedQbId] : []}
				onToggleSelect={handleToggleSelect}
				onSelect={() => {}}
				onClose={onClose}
				emptyHint={"No employees available to link to"}
			/>

			{linkMutation.isError && (
				<p className="mt-2 text-xs text-error-text">
					{(linkMutation.error as Error)?.message || "Failed to link employee."}
				</p>
			)}

			<div className="mt-5 flex justify-end gap-2">
				<button
					type="button"
					onClick={onClose}
					className="rounded-md border border-border bg-base px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={handleLink}
					disabled={!selectedQbId || linkMutation.isPending}
					className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					{linkMutation.isPending ? "Linking…" : "Link"}
				</button>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={isOpen} onClose={onClose} size="md" />;
}
