import { useState } from "react";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { usePermission } from "../../hooks/usePermission";

interface ExportExcelButtonProps {
	onExport: () => Promise<void>;
	disabled?: boolean;
}

export default function ExportExcelButton({ onExport, disabled }: ExportExcelButtonProps) {
	const [isExporting, setIsExporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canExport = usePermission("export_reports");

	const handleClick = async () => {
		if (isExporting) return;
		setIsExporting(true);
		setError(null);
		try {
			await onExport();
		} catch {
			setError("Export failed. Please try again.");
			setTimeout(() => setError(null), 5000);
		} finally {
			setIsExporting(false);
		}
	};

	if (!canExport) return null;

	return (
		<div className="relative">
			<button
				onClick={handleClick}
				disabled={disabled || isExporting}
				className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-surface text-sm text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{isExporting ? (
					<Loader2 size={14} className="animate-spin" />
				) : (
					<FileSpreadsheet size={14} />
				)}
				Export
			</button>
			{error && (
				<div className="absolute right-0 top-full mt-1 z-10 whitespace-nowrap rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 shadow-sm">
					{error}
				</div>
			)}
		</div>
	);
}
