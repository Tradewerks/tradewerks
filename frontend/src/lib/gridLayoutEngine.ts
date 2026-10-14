import type { Layout, LayoutItem } from "react-grid-layout";

// Generic react-grid-layout mechanics — bin-packing, auto-arrange ("Fit"), and
// add/remove-widget placement. Shared by any grid that has its own widget
// catalog (dashboard, KPI, ...). Domain-specific data (the catalog itself,
// default layouts) lives with each grid's own config, not here.

export const BREAKPOINTS = { lg: 0, md: 0, sm: 0 };
export const COLS       = { lg: 12,   md: 12,   sm: 12 };

// Fewer columns at smaller widths so each column is physically wider
export function getActiveCols(containerWidth: number): number {
    if (containerWidth < 500) return 4;
    if (containerWidth < 800) return 8;
    return 12;
}

export interface WidgetConstraints {
    minW?: number;
    minH?: number;
    maxW?: number;
    maxH?: number;
}

// Resolved at render time based on containerWidth. Entries sorted largest breakpoint first.
// The first entry whose `atWidth` is <= containerWidth wins. Omit to use flat min/max values.
export type ResponsiveConstraints = Array<{ atWidth: number } & WidgetConstraints>;

export interface CatalogEntry extends WidgetConstraints {
    defaultW: number;
    defaultH: number;
    responsiveConstraints?: ResponsiveConstraints;
}

export type WidgetCatalog = Record<string, CatalogEntry>;

export function resolveConstraints(
    catalog: WidgetCatalog,
    id: string,
    containerWidth: number
): WidgetConstraints {
    const w = catalog[id];
    if (!w) return {};
    const responsive = w.responsiveConstraints;
    if (responsive) {
        const match = [...responsive]
            .sort((a, b) => b.atWidth - a.atWidth)
            .find(r => containerWidth <= r.atWidth);
        if (match) {
            const { atWidth: _, ...constraints } = match;
            // merge: flat values are the base, responsive overrides on top
            return { minW: w.minW, minH: w.minH, maxW: w.maxW, maxH: w.maxH, ...constraints };
        }
    }
    return { minW: w.minW, minH: w.minH, maxW: w.maxW, maxH: w.maxH };
}

export function addWidget(catalog: WidgetCatalog, id: string, currentLayout: Layout, cols = 12): Layout {
    if (currentLayout.find(l => l.i === id)) return currentLayout;
    const def = catalog[id];
    const w = Math.min(def.defaultW, cols);
    const h = def.defaultH;
    const maxY = Math.max(0, ...currentLayout.map(l => l.y + l.h));

    // Build a set of all occupied cells so we can check free rectangles cheaply
    const occupied = new Set<string>();
    for (const item of currentLayout) {
        for (let iy = item.y; iy < item.y + item.h; iy++)
            for (let ix = item.x; ix < item.x + item.w; ix++)
                occupied.add(`${ix},${iy}`);
    }

    const isFree = (cx: number, cy: number): boolean => {
        for (let iy = cy; iy < cy + h; iy++)
            for (let ix = cx; ix < cx + w; ix++)
                if (occupied.has(`${ix},${iy}`)) return false;
        return true;
    };

    // Score = rows of the candidate rect that overlap the existing grid area.
    // A widget fully inside the current bounds scores h (best). Placing below scores 0 (fallback).
    // Scan top-to-bottom, left-to-right so the first max-score hit wins on ties.
    let bestX = 0, bestY = maxY, bestScore = -1;
    for (let cy = 0; cy <= maxY; cy++) {
        for (let cx = 0; cx <= cols - w; cx++) {
            if (!isFree(cx, cy)) continue;
            const score = Math.min(cy + h, maxY) - cy;
            if (score > bestScore) {
                bestScore = score;
                bestX = cx;
                bestY = cy;
            }
        }
    }

    return [...currentLayout, {
        i: id,
        x: bestX,
        y: bestY,
        w,
        h,
        minW: def.minW,
        minH: def.minH,
    }];
}

export function removeWidget(id: string, currentLayout: Layout): Layout {
    return currentLayout.filter(l => l.i !== id);
}

// for testing fit
export function randomizeLayout(catalog: WidgetCatalog, currentLayout: Layout, cols = COLS.lg): Layout {
    const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
    const items = [...currentLayout];
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    let y = 0;
    return items.map(item => {
        const cat = catalog[item.i];
        const maxW = Math.min(cat?.maxW ?? cols, cols);
        const minW = Math.min(cat?.minW ?? 2, maxW);
        const maxH = cat?.maxH ?? 8;
        const minH = Math.min(cat?.minH ?? 2, maxH);
        const w = rnd(minW, maxW);
        const h = rnd(minH, maxH);
        const placed = { ...item, x: rnd(0, cols - w), y, w, h };
        y += h + rnd(0, 2);
        return placed;
    });
}

interface Move{
    widget: LayoutItem,
    x: number,
    y: number,
    direction: "right" | "left" | "up" | "down" | "reposition" | "expand-left" | "expand-up",
    newW: number,
    newH: number
}

function canResize(layout: Layout, widget: LayoutItem, x: number, y: number, w: number, h: number, cols: number): boolean {
    if (x < 0 || y < 0 || x + w > cols) return false;
    for (const other of layout) {
        if (other.i === widget.i) continue;
        if (other.x < x + w && other.x + other.w > x && other.y < y + h && other.y + other.h > y) {
            return false;
        }
    }

    return true;
}

function growRightMoves(catalog: WidgetCatalog, layout: Layout, widget: LayoutItem, cols: number): Move[] {
    const moves = [] as Move[];
    const maxW = Math.min(catalog[widget.i]?.maxW ?? widget.w, cols);

    for(let newW = widget.w + 1; newW <= maxW; newW++) {
        if (canResize(layout, widget, widget.x, widget.y, newW, widget.h, cols)) {
            moves.push({ widget, x: widget.x, y: widget.y, direction: "right", newW, newH: widget.h });
        }
    }

    return moves;
}
function growLeftMoves(catalog: WidgetCatalog, layout: Layout, widget: LayoutItem, cols: number): Move[] {
    const moves = [] as Move[];
    const minW = catalog[widget.i]?.minW ?? widget.w;

    for(let newW = widget.w - 1; newW >= minW; newW--) {
        if (canResize(layout, widget, widget.x, widget.y, newW, widget.h, cols)) {
            moves.push({ widget, x: widget.x, y: widget.y, direction: "left", newW, newH: widget.h });
        }
    }

    return moves;
}
function growUpMoves(catalog: WidgetCatalog, layout: Layout, widget: LayoutItem, cols: number): Move[] {
    const moves = [] as Move[];
    const minH = catalog[widget.i]?.minH ?? widget.h;

    for(let newH = widget.h - 1; newH >= minH; newH--) {
        if (canResize(layout, widget, widget.x, widget.y, widget.w, newH, cols)) {
            moves.push({ widget, x: widget.x, y: widget.y, direction: "up", newW: widget.w, newH });
        }
    }

    return moves;
}
function growDownMoves(catalog: WidgetCatalog, layout: Layout, widget: LayoutItem, cols: number): Move[] {
    const moves = [] as Move[];
    const maxH = catalog[widget.i]?.maxH ?? widget.h;

    for(let newH = widget.h + 1; newH <= maxH; newH++) {
        if (canResize(layout, widget, widget.x, widget.y, widget.w, newH, cols)) {
            moves.push({ widget, x: widget.x, y: widget.y, direction: "down", newW: widget.w, newH });
        }
    }

    return moves;
}

function expandLeftMoves(catalog: WidgetCatalog, layout: Layout, widget: LayoutItem, cols: number): Move[] {
    const moves = [] as Move[];
    const maxW = Math.min(catalog[widget.i]?.maxW ?? widget.w, cols);
    for (let k = 1; widget.x - k >= 0 && widget.w + k <= maxW; k++) {
        const x = widget.x - k, newW = widget.w + k;
        if (canResize(layout, widget, x, widget.y, newW, widget.h, cols)) {
            moves.push({ widget, x, y: widget.y, direction: "expand-left", newW, newH: widget.h });
        }
    }
    return moves;
}
function expandUpMoves(catalog: WidgetCatalog, layout: Layout, widget: LayoutItem, cols: number): Move[] {
    const moves = [] as Move[];
    const maxH = catalog[widget.i]?.maxH ?? widget.h;
    for (let k = 1; widget.y - k >= 0 && widget.h + k <= maxH; k++) {
        const y = widget.y - k, newH = widget.h + k;
        if (canResize(layout, widget, widget.x, y, widget.w, newH, cols)) {
            moves.push({ widget, x: widget.x, y, direction: "expand-up", newW: widget.w, newH });
        }
    }
    return moves;
}

function repositionMoves(layout: Layout, widget: LayoutItem, cols: number): Move[] {
    const moves = [] as Move[];
    const boundingHeight = Math.max(0, ...layout.map(w => w.y + w.h));
    for (let y = 0; y <= boundingHeight - widget.h; y++) {
        for (let x = 0; x <= cols - widget.w; x++) {
            if (x === widget.x && y === widget.y) continue;
            if (canResize(layout, widget, x, y, widget.w, widget.h, cols)) {
                moves.push({ widget, x, y, direction: "reposition", newW: widget.w, newH: widget.h });
            }
        }
    }
    return moves;
}

function gernerateMoves(catalog: WidgetCatalog, layout: Layout, cols: number) : Move[] {
    const moves = [] as Move[];

    for (const widget of layout) {
        moves.push(...growRightMoves(catalog, layout, widget, cols));
        moves.push(...growLeftMoves(catalog, layout, widget, cols));
        moves.push(...growDownMoves(catalog, layout, widget, cols));
        moves.push(...growUpMoves(catalog, layout, widget, cols));
        moves.push(...expandLeftMoves(catalog, layout, widget, cols));
        moves.push(...expandUpMoves(catalog, layout, widget, cols));
        moves.push(...repositionMoves(layout, widget, cols));
    }

    return moves;
}

function canMoveUp(layout: Layout, widget: LayoutItem): boolean {
    if (widget.y <= 0) return false;
    const targetY = widget.y - 1;
    return !layout.some(other => other.i !== widget.i && other.x < widget.x + widget.w && other.x + other.w > widget.x && other.y < targetY + widget.h && other.y + other.h > targetY);
}


function compactLayout(layout: Layout): Layout {
    layout = layout.map(widget => ({ ...widget }));
    let moved = true;
    while (moved) {
        moved = false;
        layout = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
        for (const widget of layout) {
            while (widget.y > 0 && canMoveUp(layout, widget)) { widget.y--; moved = true; }
        }
    }
    return layout;
}

function evaluate(layout: Layout, cols: number): number {
    let occupiedArea = 0;
    layout.forEach(widget => occupiedArea += widget.w * widget.h);
    const boundingHeight = Math.max(...layout.map(widget => widget.y + widget.h));
    const emptyArea = cols * boundingHeight - occupiedArea;

    // Primary goal: fewest holes
    // Tiebreaker: prefer the shortest
    return -(emptyArea * 100000 + boundingHeight);
}

function applyMove(layout: Layout, move: Move): Layout {
    return layout.map(widget => widget.i === move.widget.i ? { ...widget, x: move.x, y: move.y, w: move.newW, h: move.newH } : widget);
}

function layoutSignature(layout: Layout): string {
    return [...layout]
        .sort((a, b) => (a.i < b.i ? -1 : 1))
        .map(w => `${w.i}:${w.x},${w.y},${w.w},${w.h}`)
        .join("|");
}

function placeWithoutOverlap(layout: Layout, cols: number): Layout {
    const placed: LayoutItem[] = [];
    const fits = (x: number, y: number, w: number, h: number) =>
        x + w <= cols &&
        !placed.some(o => o.x < x + w && o.x + o.w > x && o.y < y + h && o.y + o.h > y);
    const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const widget of ordered) {
        const w = Math.min(widget.w, cols);
        const h = widget.h;
        let done = false;
        for (let y = 0; !done; y++) {
            for (let x = 0; x <= cols - w; x++) {
                if (fits(x, y, w, h)) { placed.push({ ...widget, x, y, w }); done = true; break; }
            }
        }
    }
    return placed;
}

export function fitLayout(catalog: WidgetCatalog, layout: Layout, cols = COLS.lg, beamWidth = 6, patience = 2, maxRounds = 60): Layout {
    const TOP_TIER_CAP = 24;
    const start = compactLayout(placeWithoutOverlap(layout, cols));
    let beam: Layout[] = [start];
    let best = start;
    let bestScore = evaluate(start, cols);
    let sinceImprovement = 0;

    for (let round = 0; round < maxRounds && sinceImprovement <= patience; round++) {
        const seen = new Set<string>([layoutSignature(start)]);
        const scored: { layout: Layout; score: number }[] = [];
        for (const state of beam) {
            for (const move of gernerateMoves(catalog, state, cols)) {
                const next = compactLayout(applyMove(state, move));
                const sig = layoutSignature(next);
                if (seen.has(sig)) continue;
                seen.add(sig);
                scored.push({ layout: next, score: evaluate(next, cols) });
            }
        }
        if (scored.length === 0) break;
        scored.sort((a, b) => b.score - a.score);

        const topScore = scored[0].score;
        let tierSize = 0;
        while (tierSize < scored.length && scored[tierSize].score === topScore) tierSize++;
        const keep = Math.max(beamWidth, Math.min(tierSize, TOP_TIER_CAP));
        beam = scored.slice(0, keep).map(s => s.layout);

        if (topScore > bestScore) {
            best = scored[0].layout;
            bestScore = topScore;
            sinceImprovement = 0;
        } else {
            sinceImprovement++;
        }
    }
    return best;
}
