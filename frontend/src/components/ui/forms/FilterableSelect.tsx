import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export interface FilterableOption {
    id: string;
    label: string;
    sublabel?: string | null;
}

interface FilterableSelectProps {
    value: string;
    onChange: (text: string) => void;
    onSelect?: (option: FilterableOption) => void;
    options: FilterableOption[];
    /** Options already filtered by the caller (e.g. a server search) — skip the client-side substring filter. */
    preFiltered?: boolean;
    label?: string;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    ariaLabel?: string;
    maxLength?: number;
}

const PANEL_MAX_HEIGHT = 224;
const VIEWPORT_MARGIN = 8;
const INPUT =
    "border border-border-input px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0 disabled:opacity-60";
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";

/**
 * Free-text input with a portaled, filtered suggestion list — same interaction as
 * SupplierPicker, generalized over any {id,label} option set. Selecting a suggestion
 * fires both onSelect and, via the caller's onSelect handler, is expected to update
 * `value` — the field never locks into a read-only chip, unlike CatalogItemPicker.
 */
export default function FilterableSelect({
    value,
    onChange,
    onSelect,
    options,
    preFiltered = false,
    label,
    placeholder,
    disabled,
    className,
    ariaLabel,
    maxLength,
}: FilterableSelectProps) {
    const [open, setOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);

    // Portaled to <body>, not rendered inline — the modal this lives in clips overflow.
    useLayoutEffect(() => {
        if (!open) {
            setPanelStyle(null);
            return;
        }
        const rect = inputRef.current?.getBoundingClientRect();
        if (!rect) return;
        const spaceBelow = window.innerHeight - rect.bottom;
        const flipUp = spaceBelow < PANEL_MAX_HEIGHT + VIEWPORT_MARGIN && rect.top > spaceBelow;
        setPanelStyle(
            flipUp
                ? { position: "fixed", left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4 }
                : { position: "fixed", left: rect.left, width: rect.width, top: rect.bottom + 4 },
        );
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onScroll = (e: Event) => {
            const target = e.target;
            if (target instanceof Node && panelRef.current?.contains(target)) return;
            setOpen(false);
        };
        const close = () => setOpen(false);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", close);
        return () => {
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", close);
        };
    }, [open]);

    const q = value.trim().toLowerCase();
    const suggestions = preFiltered || !q ? options : options.filter((o) => o.label.toLowerCase().includes(q));

    return (
        <div className={`relative min-w-0 ${className ?? ""}`}>
            {label && <label className={LABEL}>{label}</label>}
            <input
                ref={inputRef}
                type="text"
                value={value}
                disabled={disabled}
                placeholder={placeholder}
                maxLength={maxLength}
                aria-label={ariaLabel ?? label}
                onChange={(e) => onChange(e.target.value)}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 120)}
                className={INPUT}
            />
            {open &&
                panelStyle &&
                suggestions.length > 0 &&
                createPortal(
                    <div
                        ref={panelRef}
                        style={panelStyle}
                        onMouseDown={(e) => e.preventDefault()}
                        className="z-[6000] max-h-56 overflow-y-auto rounded border border-border bg-surface shadow-xl"
                    >
                        {suggestions.map((o) => (
                            <button
                                key={o.id}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                    onSelect?.(o);
                                    setOpen(false);
                                }}
                                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-raised"
                            >
                                <span className="truncate">{o.label}</span>
                                {o.sublabel && (
                                    <span className="shrink-0 text-xs text-text-muted">{o.sublabel}</span>
                                )}
                            </button>
                        ))}
                    </div>,
                    document.body,
                )}
        </div>
    );
}
