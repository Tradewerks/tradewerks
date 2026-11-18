import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { getPublicLink, type PublicLinkData } from "../../api/publicLinks";
import InvoiceView from "./InvoiceView";
import PublicShell from "./PublicShell";
import QuoteView from "./QuoteView";
import UnsubscribeView from "./UnsubscribeView";
import VisitView from "./VisitView";
import { textButtonClass } from "./publicStyles";

// Customer-facing page for every emailed or texted link. Renders outside
// DispatchLayout and never touches the auth store: the token in the URL is the
// only credential.
export default function PublicLinkPage() {
	const { token = "" } = useParams();
	const link = useQuery({
		queryKey: ["public-link", token],
		queryFn: () => getPublicLink(token),
		enabled: token.length > 0,
		retry: false,
		// A refetch would replace the page under a customer mid-answer.
		refetchOnWindowFocus: false,
		// Live ETA: poll only while the tech is driving. TanStack pauses the
		// interval in a background tab; this read never sends mark_viewed.
		refetchInterval: (query) => {
			const d = query.state.data;
			return d?.purpose === "visit" && d.phase === "driving" ? 60_000 : false;
		},
	});

	const err = link.error;
	// Only a 404 means the link is dead; a 429, 5xx or network failure says nothing about it.
	const dead = !token || (isAxiosError(err) && err.response?.status === 404);

	if (dead) {
		// Unknown, expired and revoked links look identical and carry no org.
		return (
			<PublicShell>
				<div className="space-y-2 py-4 text-center">
					<h1 className="text-xl font-semibold">
						Link not available
					</h1>
					<p className="text-sm text-zinc-600 dark:text-zinc-400">
						This link has expired or is no longer valid. Contact
						the company that sent it.
					</p>
				</div>
			</PublicShell>
		);
	}
	// A failed background refetch keeps the last good page instead of replacing it.
	if (err && !link.data) {
		return (
			<PublicShell>
				<div className="space-y-2 py-4 text-center">
					<p
						role="alert"
						className="text-sm text-zinc-600 dark:text-zinc-400"
					>
						Could not load this page. Try again.
					</p>
					<button
						type="button"
						onClick={() => link.refetch()}
						disabled={link.isFetching}
						className={textButtonClass}
					>
						Try again
					</button>
				</div>
			</PublicShell>
		);
	}
	if (!link.data) {
		return (
			<PublicShell>
				<div
					className="h-48 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800"
					aria-busy="true"
				/>
			</PublicShell>
		);
	}
	return (
		<PublicShell org={link.data.org}>
			<LinkBody token={token} data={link.data} />
		</PublicShell>
	);
}

function LinkBody({ token, data }: { token: string; data: PublicLinkData }) {
	switch (data.purpose) {
		case "unsubscribe":
			return <UnsubscribeView token={token} data={data} />;
		case "quote":
			return <QuoteView token={token} data={data} />;
		case "invoice":
			return <InvoiceView token={token} data={data} />;
		case "visit":
			return <VisitView data={data} />;
	}
}
