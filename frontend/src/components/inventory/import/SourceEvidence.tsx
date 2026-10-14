import { FileImage, FileSpreadsheet, FileText } from "lucide-react";
import type { InventoryImportCandidate } from "../../../types/inventoryImport";

export default function SourceEvidence({ candidate }: { candidate: InventoryImportCandidate }) {
	const Icon = candidate.source.source_type === "spreadsheet" || candidate.source.source_type === "csv"
		? FileSpreadsheet
		: candidate.source.source_type === "pdf"
			? FileText
			: FileImage;
	const locator = candidate.sheet_name
		? `${candidate.sheet_name} · Row ${candidate.row_number ?? "—"}`
		: candidate.page_number
			? `Page ${candidate.page_number}`
			: candidate.image_index != null
				? `Image ${candidate.image_index + 1}`
				: "Source file";
	return (
		<div className="flex items-center gap-2 text-xs text-muted">
			<Icon size={14} />
			<span className="shrink-0">From</span>
			<span className="truncate">{candidate.source.original_filename}</span>
			<span aria-hidden className="text-faint">·</span>
			<span className="shrink-0">{locator}</span>
		</div>
	);
}
