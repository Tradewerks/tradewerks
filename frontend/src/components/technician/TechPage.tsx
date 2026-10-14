import type { ReactNode } from "react";

// Single source of truth for how wide technician content sits on desktop.
// Mobile is unaffected: both tiers are max-w-lg until lg.
//
// "wide" exists for pages that have a real multi-column desktop layout
// (currently only the dashboard's lg:grid-cols-2). Everything else is a single
// reading column, so widening it would just stretch rows.
//
// Horizontal padding stays on TechnicianLayout rather than here, because
// MyProfilePage renders through the same Outlet and is shared with dispatch.
const WIDTH = {
	narrow: "max-w-lg",
	wide: "max-w-lg lg:max-w-4xl",
} as const;

export default function TechPage({
	width = "narrow",
	className = "",
	children,
}: {
	width?: keyof typeof WIDTH;
	className?: string;
	children: ReactNode;
}) {
	return <div className={`mx-auto w-full ${WIDTH[width]} ${className}`}>{children}</div>;
}
