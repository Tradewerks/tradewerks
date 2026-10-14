/*
  Warnings:

  - Added the required column `purchase_number` to the `purchase` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "purchase" ADD COLUMN     "purchase_number" TEXT NOT NULL;
