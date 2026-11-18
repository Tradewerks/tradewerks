import type { ReactNode } from "react";
import type { PublicOrg } from "../../api/publicLinks";

// Customer pages are the one place the app follows the device's light/dark
// setting instead of the dispatcher theme: they are opened from an email on a
// phone, outside the app. `dark:` here is Tailwind's prefers-color-scheme variant.

interface Props {
	/** Omitted for a dead link, so the page gives no hint of whose link it was. */
	org?: PublicOrg;
	children: ReactNode;
}

export default function PublicShell({ org, children }: Props) {
	return (
		<div className="min-h-screen bg-zinc-100 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
			<div className="mx-auto w-full max-w-xl px-4 pb-10 pt-4 sm:pt-8">
				{org && (
					<header className="flex items-center gap-3 pb-4">
						{org.logo_url && (
							<img
								src={org.logo_url}
								alt=""
								className="h-10 w-10 shrink-0 rounded-md object-contain"
							/>
						)}
						<div className="min-w-0">
							<p className="truncate text-base font-semibold">
								{org.name}
							</p>
							{org.phone && (
								<a
									href={`tel:${org.phone.replace(/[^\d+]/g, "")}`}
									className="text-sm text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400"
								>
									{org.phone}
								</a>
							)}
						</div>
					</header>
				)}
				<main className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
					{children}
				</main>
			</div>
		</div>
	);
}
