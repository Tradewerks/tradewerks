import { useQuery } from "@tanstack/react-query";
import { getBusinessTypes } from "../api/organizations";

export const useBusinessTypes = () =>
	useQuery({ queryKey: ["business-types"], queryFn: getBusinessTypes, staleTime: Infinity });
