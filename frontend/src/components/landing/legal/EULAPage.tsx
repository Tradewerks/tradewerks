import LegalLayout from "./LegalLayout";

export default function EULAPage() {
	return (
		<LegalLayout title="End User License Agreement">
			<div {...{ name: "termly-embed" }} data-id="106c67b9-8642-43a4-9800-d173c0c0118d" />
			<script src="https://app.termly.io/embed-policy.min.js" async />
		</LegalLayout>
	);
}
