-- AlterTable
ALTER TABLE "purchase_line" ADD COLUMN     "quantity_recieved" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "received_at" TIMESTAMP(3);
