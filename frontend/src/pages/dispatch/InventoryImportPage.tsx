import { useCallback, useState } from "react";
import { ArrowLeft, Download, FilePlus2, FileSpreadsheet, Upload, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { downloadInventoryTemplate } from "../../api/inventory";
import { useCreateInventoryImport } from "../../hooks/useInventoryImports";

const ACCEPT = ".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif";

export default function InventoryImportPage() {
	const navigate = useNavigate();
	const create = useCreateInventoryImport();
	const [files, setFiles] = useState<File[]>([]);
	const [dragging, setDragging] = useState(false);

	const addFiles = useCallback((incoming: FileList | File[]) => {
		setFiles((current) => {
			const next = [...current];
			for (const file of Array.from(incoming)) {
				if (!next.some((item) => item.name === file.name && item.size === file.size)) next.push(file);
			}
			return next.slice(0, 20);
		});
	}, []);

	const submit = () => {
		if (!files.length) return;
		create.mutate(files, { onSuccess: (record) => navigate(`/dispatch/inventory/imports/${record.id}`) });
	};

	return (
		<div className="mx-auto max-w-4xl space-y-6 p-6">
			<div className="flex items-center justify-between gap-4">
				<div>
					<Link to="/dispatch/inventory/imports" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-link"><ArrowLeft size={14} /> Import history</Link>
					<h1 className="text-2xl font-semibold text-text-primary">New inventory import</h1>
					<p className="mt-1 text-sm text-muted">Upload source files now. Nothing reaches inventory until review, financial approval, and commit.</p>
				</div>
				<button type="button" onClick={() => void downloadInventoryTemplate()} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-secondary hover:bg-base"><Download size={15} /> Template</button>
			</div>

			<div
				onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
				className={`relative rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${dragging ? "border-primary bg-primary-bg" : "border-border bg-base"}`}
			>
				<input id="inventory-import-files" type="file" accept={ACCEPT} multiple className="sr-only" onChange={(event) => event.target.files && addFiles(event.target.files)} />
				<Upload size={30} className="mx-auto mb-3 text-link" />
				<p className="font-medium text-text-primary">Drop spreadsheets, PDFs, invoices, or product photos</p>
				<p className="mt-1 text-sm text-muted">Every non-empty worksheet is imported. Up to 20 files, 10 MB each.</p>
				<label htmlFor="inventory-import-files" className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary"><FilePlus2 size={15} /> Choose files</label>
			</div>

			{files.length > 0 && (
				<div className="rounded-xl border border-border bg-base">
					<div className="border-b border-border px-4 py-3 text-sm font-medium text-text-primary">{files.length} source{files.length === 1 ? "" : "s"}</div>
					<ul className="divide-y divide-border">
						{files.map((file, index) => (
							<li key={`${file.name}-${file.size}`} className="flex items-center gap-3 px-4 py-3">
								<FileSpreadsheet size={16} className="text-link" />
								<div className="min-w-0 flex-1"><p className="truncate text-sm text-text-primary">{file.name}</p><p className="text-xs text-muted">{(file.size / 1024).toFixed(1)} KB</p></div>
								<button type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded p-1 text-muted hover:text-error-text" aria-label={`Remove ${file.name}`}><X size={16} /></button>
							</li>
						))}
					</ul>
				</div>
			)}

			{create.error && <p className="rounded-lg border border-error-border bg-error-bg p-3 text-sm text-error-text">{create.error.message}</p>}
			<div className="flex justify-end">
				<button type="button" onClick={submit} disabled={!files.length || create.isPending} className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-50">
					{create.isPending ? "Creating draft…" : "Upload and extract"}
				</button>
			</div>
		</div>
	);
}
