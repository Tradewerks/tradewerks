import { NavLink } from "react-router-dom";

export default function SideNavItem({
	to,
	icon,
	label,
	expanded,
}: {
	to: string;
	icon: React.ReactNode;
	label: string;
	expanded: boolean;
}) {
	return (
		<NavLink
			to={to}
			end
			className={({ isActive }) =>
				`
				group relative flex items-center h-10 rounded-md mx-2
				transition-colors duration-200
				${isActive ? "bg-primary-bg text-primary-text" : "text-text-tertiary hover:text-text-primary hover:bg-surface-raised"}
				`
			}
		>
			{/* Icon container - fixed at collapsed sidebar width for alignment */}
			<div className="w-12 flex items-center justify-center flex-shrink-0">
				{icon}
			</div>

			{/* Label - min-w-0 is what lets truncate work inside the flex row */}
			<div
				className={`
					flex-1 min-w-0 flex items-center overflow-hidden
					transition-[opacity,transform] duration-200 ease-in-out
					${expanded ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2 pointer-events-none"}
				`}
			>
				<span className="text-sm whitespace-nowrap truncate w-full pr-2">
					{label}
				</span>
			</div>
		</NavLink>
	);
}
