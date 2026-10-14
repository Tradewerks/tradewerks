import React, { Fragment, useState } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { camelCaseToRegular, formatter } from "../util/util";
import LoadSvg from "../assets/icons/loading.svg?react";
import BoxSvg from "../assets/icons/box.svg?react";
import ErrSvg from "../assets/icons/error.svg?react";
import type { SortDir } from "../util/sortUtil";
import { ArrowUpDown, ChevronDown, ChevronRight, ChevronUp } from "lucide-react";

interface AdaptableTableProps {
	data: Array<Record<string, unknown>>;
	borderColor?: string;
	formatNums?: boolean;
	loadListener?: boolean;
	errListener?: Error | null;
	onRowClick?: (row: Record<string, unknown>) => void;
	actionColumn?: {
		header: string;
		cell: (row: Record<string, unknown>) => React.ReactNode;
	};
	// Per-column visibility keyed by column id and missing keys default to visible
	columnVisibility?: Record<string, boolean>;
	// Per-column header text keyed by column id
	headerLabels?: Record<string, string>;
	// Per-column horizontal alignment keyed by column id
	columnAlign?: Record<string, "left" | "right">;
	// Optional totals row keyed by column id
	footerRow?: Record<string, React.ReactNode>;
	// Per-column extra CSS classes, computed from the row.
	cellClass?: Record<string, (row: Record<string, unknown>) => string>;
	// Per-column width cap. Layout is `auto`, so one long cell can push every
	// column off the right edge; the cap goes on a wrapper INSIDE the cell,
	// since auto layout ignores a width set on the <td> itself.
	columnClamp?: Record<string, ColumnClamp>;
	// Render cells with a component instead of the default text rendering
	cellRenderers?: Record<string, (row: Record<string, unknown>) => React.ReactNode>;
	// optional row expansion via dropdown
	renderExpanded?: (row: Record<string, unknown>) => React.ReactNode;
	// Always-visible full-width row under each row
	renderSubRow?: (row: Record<string, unknown>) => React.ReactNode;
	// Adds sorts options directly to the table
	sortableColumns?: Record<string, boolean>;
	sortKey?: string;
	sortDir?: SortDir;
	onSortChange?: (col: string) => void; 
}

export interface ColumnClamp {
	// Any CSS length; omit to leave the column self-sizing.
	maxWidth?: string;
	// Lines shown before the ellipsis. Defaults to 1.
	lines?: 1 | 2 | 3;
}

// Static class strings — Tailwind only emits what it can read in the source.
const CLAMP_LINES: Record<number, string> = {
	1: "truncate",
	// `break-words` so an unbreakable token wraps instead of running out the
	// side of the clamp, where there is no ellipsis to say it was cut.
	2: "line-clamp-2 break-words",
	3: "line-clamp-3 break-words",
};

// Full value on hover for anything long enough to have plausibly been cut.
// Short cells are skipped: a native tooltip reading "0" is noise on every
// numeric column in the table.
const TITLE_MIN_LENGTH = 20;
const clampTitle = (value: unknown) =>
	typeof value === "string" && value.length > TITLE_MIN_LENGTH ? value : undefined;

const PADDING = "p-3";
const MIN_HEIGHT = 150;

const IGNORED_HEADERS: Record<string, boolean> = {
	id: true,
};

const AdaptableTable = ({
	data,
	borderColor,
	formatNums = true,
	loadListener,
	errListener,
	onRowClick,
	actionColumn,
	columnVisibility,
	headerLabels,
	columnAlign,
	footerRow,
	cellClass,
	columnClamp,
	cellRenderers,
	renderExpanded,
	renderSubRow,
	sortableColumns,
	sortKey,
	sortDir,
	onSortChange,
}: AdaptableTableProps) => {
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const alignClass = (colId: string) => {
		if (!columnAlign) return "";
		return columnAlign[colId] === "right" ? "text-right tabular-nums" : "text-left";
	};
	const columns = React.useMemo(() => {
		if (data.length == 0) return [];

		const dataColumns = Object.keys(data[0])
			.filter((key) => !IGNORED_HEADERS[key] && !key.startsWith("_"))
			.map((key) => ({
				header: headerLabels?.[key] ?? camelCaseToRegular(key),
				accessorKey: key,
			})) satisfies ColumnDef<Record<string, unknown>>[];

		// Add action column if provided
		if (actionColumn) {
			return [
				...dataColumns,
				{
					header: actionColumn.header,
					id: 'actions',
					cell: ({ row }) => actionColumn.cell(row.original),
				},
			] satisfies ColumnDef<Record<string, unknown>>[];
		}

		return dataColumns;
	}, [data, actionColumn, headerLabels]);

	const table = useReactTable({
		data,
		columns,
		getCoreRowModel: getCoreRowModel(),
		...(columnVisibility ? { state: { columnVisibility } } : {}),
	});

	if (!borderColor) borderColor = " border-border-subtle ";

	if (errListener) {
		return (
			<div
				className={`w-full h-${MIN_HEIGHT} flex flex-col justify-center content-center`}
			>
				<div>
					<ErrSvg className="m-auto mb-1 w-15 h-15" />

					<h1 className="m-auto text-center text-xl mt-1">
						An error has occurred.
					</h1>

					{/* this should be taken out in prod, just for debug purposes */}
					<h2 className="m-auto text-center text-text-muted">
						{errListener.message}
					</h2>
				</div>
			</div>
		);
	}

	if (data.length == 0 && !loadListener) {
		return (
			<div
				className={`w-full h-${MIN_HEIGHT} flex flex-col justify-center content-center`}
			>
				<div>
					<BoxSvg className="m-auto mb-1 w-15 h-15" />

					<h1 className="m-auto text-center text-xl mt-1">
						Nothing to display.
					</h1>
				</div>
			</div>
		);
	}

	const sortable = (colId:string) => !!sortableColumns?.[colId];

	return (
		<>
			{loadListener ? (
				<div
					className={`w-full h-${MIN_HEIGHT} flex flex-col justify-center content-center`}
				>
					<div>
						<LoadSvg className="m-auto mb-3 w-12 h-12" />

						<h1 className="m-auto text-center text-xl mt-3">
							Please wait...
						</h1>
					</div>
				</div>
			) : (
				<table className={`w-full h-full min-h-${MIN_HEIGHT} table-auto`}>
					<thead>
						{table.getHeaderGroups().map((headerGroup) => (
							<tr key={headerGroup.id}>
								{headerGroup.headers.map(
									(header) => (
										<th
											key={
												header.id
											}
											onClick={() => {if (onSortChange && sortable(header.column.id)) onSortChange(header.column.id)}}
											className={`${sortable(header.column.id) ? "cursor-pointer select-none" : ""} sticky top-0 border-b font-bold text-text-tertiary ${borderColor} ${PADDING} ${alignClass(header.column.id)}`}
										>
											{flexRender(
												typeof header
													.column
													.columnDef
													.header ===
													"string"
													? camelCaseToRegular(
															header
																.column
																.columnDef
																.header
														)
													: header
															.column
															.columnDef
															.header,
												header.getContext()
											)}
											{sortable(header.column.id) && (
												<span
														className="ml-1 inline-flex"
														aria-label="Sort"
												>
														{sortKey === header.column.id ? (
																sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />
														) : (
																<ArrowUpDown size={12} className="text-text-faint" />
														)}
												</span>
											)}
										</th>
									)
								)}
							</tr>
						))}
					</thead>
					<tbody>
						{table.getRowModel().rows.map((row) => (
							<Fragment key={row.id} >
								<tr
									className={`text-left ${borderColor} ${onRowClick || renderExpanded ? 'cursor-pointer hover:bg-surface-raised transition-colors' : ''} ${renderSubRow && renderExpanded ? "[&:has(+tr:hover)]:bg-surface-raised" : ""}`}
									onClick={() => {
										onRowClick?.(row.original);
										if (renderExpanded) setExpandedId((id) => (id === row.id ? null : row.id));
									}}
									aria-expanded={renderExpanded ? expandedId === row.id : undefined}
								>
									{row
										.getVisibleCells()
										.map((cell, cellIndex) => {
											const rawValue =
												cell.getValue();
											const content = (() => {
												// If this is the actions column, render the action cell
												if (cell.column.id === 'actions') {
													return flexRender(
														cell.column.columnDef.cell,
														cell.getContext()
													);
												}

												if (cellRenderers?.[cell.column.id]) {
													return cellRenderers[cell.column.id](row.original);
												}

												if (
													typeof rawValue ===
													"number"
												)
													return formatNums
														? formatter.format(
																rawValue
															)
														: rawValue.toLocaleString();

												return flexRender(
													cell
														.column
														.columnDef
														.cell,
													cell.getContext()
												);
											})();

											const clamp =
												columnClamp?.[
													cell.column
														.id
												];

											return (
												<td
													key={
														cell.id
													}
													className={`border-t border-border-subtle font-normal ${PADDING} ${alignClass(cell.column.id)} ${cellClass?.[cell.column.id]?.(row.original) ?? ""}`}
												>
													{renderExpanded && cellIndex === 0 && (
														<ChevronRight
															size={16}
															aria-hidden
															className={`inline mr-2 align-text-bottom text-text-muted transition-transform ${expandedId === row.id ? "rotate-90" : ""}`}
														/>
													)}
													{clamp ? (
														<div
															className={
																CLAMP_LINES[
																	clamp.lines ??
																		1
																]
															}
															style={
																clamp.maxWidth
																	? {
																			maxWidth: clamp.maxWidth,
																		}
																	: undefined
															}
															title={clampTitle(
																rawValue
															)}
														>
															{
																content
															}
														</div>
													) : (
														content
													)}
												</td>
											);
										})}
								</tr>
								{renderSubRow && (
									<tr
										className={renderExpanded ? "cursor-pointer hover:bg-surface-raised [tr:hover+&]:bg-surface-raised transition-colors" : ""}
										onClick={() => renderExpanded && setExpandedId((id) => (id === row.id ? null : row.id))}
									>
										<td colSpan={row.getVisibleCells().length} className={`${PADDING} pt-0`}>
											{renderSubRow(row.original)}
										</td>
									</tr>
								)}
								{renderExpanded && expandedId === row.id && (
									<tr>
										<td colSpan={row.getVisibleCells().length} className="border-t border-border-subtle">
											{renderExpanded(row.original)}
										</td>
									</tr>
								)}
							</Fragment>
						))}
					</tbody>
					{footerRow && (
						<tfoot>
							<tr className="font-semibold text-text-primary">
								{table.getVisibleLeafColumns().map((col) => (
									<td
										key={col.id}
										className={`border-t-2 border-border ${PADDING} ${alignClass(col.id)}`}
									>
										{footerRow[col.id] ?? ""}
									</td>
								))}
							</tr>
						</tfoot>
					)}
				</table>
			)}
		</>
	);
};

export default AdaptableTable;