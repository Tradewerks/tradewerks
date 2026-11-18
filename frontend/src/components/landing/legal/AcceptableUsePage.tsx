import LegalLayout from "./LegalLayout";

export default function AcceptableUsePage() {
	return (
		<LegalLayout title="Acceptable Use Policy">
			<div {...{ name: "termly-embed" }} data-id="3df84357-c193-4af9-b3d0-7c98d9691f49" />
			<script src="https://app.termly.io/embed-policy.min.js" async />
		</LegalLayout>
	);
}
