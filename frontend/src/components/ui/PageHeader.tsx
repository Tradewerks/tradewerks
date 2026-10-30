interface PageHeaderProps {
	title: string;
	subtitle?: React.ReactNode;
	children?: React.ReactNode;
}

export default function PageHeader({ title, subtitle, children }: PageHeaderProps) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3">
			<div className="min-w-0">
				<h2 className="text-2xl font-semibold">{title}</h2>
				{subtitle && <div className="mt-0.5">{subtitle}</div>}
			</div>
			{children && <div className="flex items-center gap-2">{children}</div>}
		</div>
	);
}
