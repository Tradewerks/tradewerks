import LegalLayout from "./LegalLayout";

export default function PrivacyPage() {
	return (
		<LegalLayout title="Privacy Policy">
			<div {...{ name: "termly-embed" }} data-id="242d7d0e-bbfe-4ea9-915d-5c929279cb73" />
			<script src="https://app.termly.io/embed-policy.min.js" async />
		</LegalLayout>
	);
}
