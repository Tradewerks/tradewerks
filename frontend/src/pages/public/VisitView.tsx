import type { VisitLinkData } from "../../api/publicLinks";

interface Props {
	data: VisitLinkData;
}

function techLine(names: string[]): string | null {
	if (names.length === 0) return null;
	return names.length === 1
		? names[0]
		: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default function VisitView({ data }: Props) {
	const techs = techLine(data.tech_first_names);
	const phone = data.org.phone;
	const arrived = data.phase === "arrived";
	const summary = data.summary;
	// With several techs on the visit there is no way to say whose face it is.
	const techPhoto = data.tech_first_names.length === 1 ? data.tech_photo_url : null;

	return (
		<div className="space-y-5">
			<div>
				<p className="text-sm text-zinc-500">Service visit</p>
				<h1 className="mt-0.5 text-xl font-semibold">
					{data.status_label}
				</h1>
				{arrived && (
					<p className="mt-1 text-base font-medium">
						{data.tech_first_names[0] ?? "Your technician"} has arrived
					</p>
				)}
				{data.eta && (
					<p className="mt-1 text-base font-medium tabular-nums">
						Estimated arrival {data.eta}
					</p>
				)}
			</div>

			{summary && (summary.name || summary.description) && (
				<div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
					<h2 className="text-sm text-zinc-500">Work done</h2>
					{summary.name && <p className="mt-0.5 font-medium">{summary.name}</p>}
					{summary.description && (
						<p className="mt-1 whitespace-pre-line break-words text-sm text-zinc-700 dark:text-zinc-300">
							{summary.description}
						</p>
					)}
				</div>
			)}

			<dl className="space-y-3 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
				<div>
					<dt className="text-zinc-500">When</dt>
					<dd className="mt-0.5 font-medium">
						{data.date}
						{data.window && (
							<span className="block font-normal text-zinc-600 dark:text-zinc-400">
								{data.window}
							</span>
						)}
					</dd>
				</div>
				<div>
					<dt className="text-zinc-500">Where</dt>
					<dd className="mt-0.5 break-words font-medium">
						{data.address}
					</dd>
				</div>
				{techs && (
					<div>
						<dt className="text-zinc-500">
							{data.tech_first_names.length > 1
								? "Technicians"
								: "Technician"}
						</dt>
						<dd className="mt-0.5 flex items-center gap-2.5 font-medium">
							{techPhoto && (
								<img
									src={techPhoto}
									alt={data.tech_first_names[0]}
									width={40}
									height={40}
									className="h-10 w-10 shrink-0 rounded-full bg-zinc-100 object-cover dark:bg-zinc-800"
								/>
							)}
							{techs}
						</dd>
					</div>
				)}
			</dl>

			{data.photos.length > 0 && (
				<section className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
					<h2 className="text-sm text-zinc-500">Photos</h2>
					<ul className="mt-2 grid grid-cols-2 gap-2">
						{data.photos.map((p) => (
							<li key={p.url}>
								<a href={p.url} target="_blank" rel="noopener noreferrer" className="block">
									<img
										src={p.url}
										alt={p.name ?? `${p.label} photo`}
										loading="lazy"
										decoding="async"
										className="aspect-square w-full rounded-lg bg-zinc-100 object-cover dark:bg-zinc-800"
									/>
								</a>
								<p className="mt-1 truncate text-xs text-zinc-600 dark:text-zinc-400">
									{p.name ? `${p.label} · ${p.name}` : p.label}
								</p>
							</li>
						))}
					</ul>
				</section>
			)}

			<p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
				Need to change this visit? Contact {data.org.name}
				{phone ? ` at ${phone}` : ""}.
			</p>
		</div>
	);
}
