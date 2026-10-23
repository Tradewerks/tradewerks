-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "cost_per_mile" DECIMAL(8,4) NOT NULL DEFAULT 0,
ADD COLUMN     "monthly_overhead" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "overhead_rate_per_hour" DECIMAL(10,4);

-- AlterTable
ALTER TABLE "technician" ADD COLUMN     "cost_rate" DECIMAL(10,2);
