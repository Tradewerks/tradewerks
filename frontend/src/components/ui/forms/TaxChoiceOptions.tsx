import type { TaxGroup } from "../../../types/tax";
import { formatTaxGroupLabel } from "../../../types/tax";

/** Options for a line tax `<select>`; pair with parseTaxChoice to read the value back. */
interface TaxChoiceOptionsProps {
	taxGroups: TaxGroup[];
	autoMode: boolean;
	/** Manual mode only: label of the address rate the document kept; adds a leading "auto" option. */
	keptRateLabel?: string | null;
}

const TaxChoiceOptions = ({ taxGroups, autoMode, keptRateLabel = null }: TaxChoiceOptionsProps) => {
	const groupOptions =
		taxGroups.length === 0 ? (
			<option value="" disabled>
				No tax groups configured
			</option>
		) : (
			taxGroups.map((group) => (
				<option key={group.id} value={group.id}>
					{formatTaxGroupLabel(group)}
				</option>
			))
		);

	return (
		<>
			{autoMode && <option value="auto">Auto (address)</option>}
			{!autoMode && keptRateLabel && <option value="auto">{keptRateLabel}</option>}
			<option value="none">No Tax</option>
			{autoMode ? <optgroup label="Override">{groupOptions}</optgroup> : groupOptions}
		</>
	);
};

export default TaxChoiceOptions;
