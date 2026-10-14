import { useState, useRef, useCallback } from "react";
import { X, Upload, Download, FileSpreadsheet, CheckCircle, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
	importInventory,
	downloadInventoryTemplate,
	exportLowStockInventory,
	type ImportResult,
} from "../../api/inventory";
import { invalidate } from "../../lib/queryKeys";

const ACCEPTED_EXTS = [".xlsx", ".xls", ".csv"];
const ACCEPTED_MIMES = [
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-excel",
	"text/csv",
	"application/csv",
];
const DRAFT_WORKFLOW_ENABLED = import.meta.env.VITE_INVENTORY_AI_IMPORT_ENABLED === "true";

function isValidFile(file: File) {
	const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
	return ACCEPTED_EXTS.includes(ext) || ACCEPTED_MIMES.includes(file.type);
}

interface Props {
	isOpen: boolean;
	onClose: () => void;
}

export default function InventoryImportExport({ isOpen, onClose }: Props) {
	const navigate = useNavigate();
	const [isDragging, setIsDragging] = useState(false);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [isImporting, setIsImporting] = useState(false);
	const [importResult, setImportResult] = useState<ImportResult | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();

	const selectFile = (file: File) => {
		if (!isValidFile(file)) {
			setImportError("Invalid file type. Please upload .xlsx, .xls, or .csv");
			return;
		}
		setSelectedFile(file);
		setImportResult(null);
		setImportError(null);
	};

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
		const file = e.dataTransfer.files[0];
		if (file) selectFile(file);
	}, []);

	// May be absent on older/cached responses; default so it doesn't blank the panel.
	const warnings = importResult?.warnings ?? [];

	const handleImport = async () => {
		if (!selectedFile) return;
		setIsImporting(true);
		setImportError(null);
		try {
			const result = await importInventory(selectedFile);
			setImportResult(result);
			invalidate.warehouse(queryClient);
		} catch (e) {
			setImportError(e instanceof Error ? e.message : "Import failed");
		} finally {
			setIsImporting(false);
		}
	};

	const handleExport = async () => {
		setIsExporting(true);
		try {
			await exportLowStockInventory();
		} finally {
			setIsExporting(false);
		}
	};

	const handleDownloadTemplate = async () => {
		setIsDownloadingTemplate(true);
		try {
			await downloadInventoryTemplate();
		} finally {
			setIsDownloadingTemplate(false);
		}
	};

	const handleClose = () => {
		setSelectedFile(null);
		setImportResult(null);
		setImportError(null);
		onClose();
	};

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
			<div className="bg-canvas border border-border rounded-xl p-6 w-full max-w-md mx-4">
				{/* Header */}
				<div className="flex items-center justify-between mb-5">
					<div className="flex items-center gap-2">
						<FileSpreadsheet size={18} className="text-link" />
						<h3 className="text-base font-semibold text-text-primary">Import / Export</h3>
					</div>
					<button
						onClick={handleClose}
						className="text-muted hover:text-primary transition-colors"
					>
						<X size={18} />
					</button>
				</div>

				{/* Import Section */}
				<div className="mb-5">
					<div className="flex items-center justify-between mb-3">
						<h4 className="text-sm font-medium text-secondary">Import Items</h4>
						<button
							onClick={handleDownloadTemplate}
							disabled={isDownloadingTemplate}
							className="flex items-center gap-1 text-xs text-link hover:text-primary-text transition-colors disabled:opacity-50"
						>
							<Download size={11} />
							{isDownloadingTemplate ? "Downloading…" : "Download Template"}
						</button>
					</div>

					{DRAFT_WORKFLOW_ENABLED ? (
						<div className="rounded-lg border border-border bg-base p-4">
							<p className="text-sm text-text-primary">Imports now open as persistent drafts for extraction, duplicate review, and approval before stock changes.</p>
							<button
								type="button"
								onClick={() => { handleClose(); navigate("/dispatch/inventory/imports/new"); }}
								className="mt-3 w-full h-9 rounded-md bg-primary hover:bg-primary-hover text-sm font-medium text-on-primary"
							>
								Start reviewed import
							</button>
							<button type="button" onClick={() => { handleClose(); navigate("/dispatch/inventory/imports"); }} className="mt-2 w-full text-xs text-link hover:underline">View import history</button>
						</div>
					) : (
					<>
					{/* Drop zone */}
					<div
						onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
						onDragLeave={() => setIsDragging(false)}
						onDrop={handleDrop}
						onClick={() => fileInputRef.current?.click()}
						className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
							isDragging
								? "border-primary bg-primary-bg"
								: selectedFile
								? "border-border bg-base"
								: "border-subtle hover:border-border"
						}`}
					>
						<input
							ref={fileInputRef}
							type="file"
							accept=".xlsx,.xls,.csv"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) selectFile(file);
								e.target.value = "";
							}}
						/>
						{selectedFile ? (
							<div className="flex items-center justify-center gap-2">
								<FileSpreadsheet size={18} className="text-success shrink-0" />
								<span className="text-sm text-text-primary truncate max-w-[220px]">
									{selectedFile.name}
								</span>
								<button
									onClick={(e) => {
										e.stopPropagation();
										setSelectedFile(null);
										setImportResult(null);
										setImportError(null);
									}}
									className="text-muted hover:text-primary ml-1 shrink-0"
								>
									<X size={14} />
								</button>
							</div>
						) : (
							<>
								<Upload size={22} className="mx-auto text-muted mb-2" />
								<p className="text-sm text-muted">
									Drop a file here or{" "}
									<span className="text-link">browse</span>
								</p>
								<p className="text-xs text-muted mt-1">.xlsx, .xls, .csv</p>
							</>
						)}
					</div>

					{importError && (
						<div className="mt-2 flex items-center gap-1.5 text-xs text-error-text">
							<AlertCircle size={13} />
							{importError}
						</div>
					)}

					{importResult && (
						<div className="mt-3 rounded-lg bg-base border border-border p-3 space-y-2">
							<div className="flex items-center gap-1.5 text-sm text-success">
								<CheckCircle size={14} />
								{importResult.imported} item
								{importResult.imported !== 1 ? "s" : ""} imported successfully
							</div>
							{importResult.skipped.length > 0 && (
								<div className="space-y-1 max-h-28 overflow-y-auto">
									<p className="text-xs text-warning-text">
										{importResult.skipped.length} row
										{importResult.skipped.length !== 1 ? "s" : ""} skipped:
									</p>
									{importResult.skipped.map((s) => (
										<p key={s.row} className="text-xs text-muted">
											Row {s.row}: {s.reason}
										</p>
									))}
								</div>
							)}
							{/* Separate from skipped rows: these still produced items. */}
							{warnings.length > 0 && (
								<div className="space-y-1 max-h-28 overflow-y-auto">
									<p className="text-xs text-warning-text">
										{warnings.length} row
										{warnings.length !== 1 ? "s" : ""} imported with
										changes:
									</p>
									{warnings.map((w) => (
										<p key={w.row} className="text-xs text-muted">
											Row {w.row}: {w.message}
										</p>
									))}
								</div>
							)}
						</div>
					)}

					<button
						onClick={handleImport}
						disabled={!selectedFile || isImporting || !!importResult}
						className="mt-3 w-full h-9 rounded-md bg-primary hover:bg-primary-hover text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{isImporting ? "Importing…" : importResult ? "Done" : "Import Items"}
					</button>
					</>
					)}
				</div>

				{/* Divider */}
				<div className="border-t border-subtle mb-5" />

				{/* Export Section */}
				<div>
					<h4 className="text-sm font-medium text-secondary mb-3">Export</h4>
					<button
						onClick={handleExport}
						disabled={isExporting}
						className="w-full h-9 flex items-center justify-center gap-2 rounded-md border border-border hover:bg-base text-sm text-secondary transition-colors disabled:opacity-50"
					>
						<Download size={14} />
						{isExporting ? "Exporting…" : "Export Low Stock List"}
					</button>
				</div>
			</div>
		</div>
	);
}
