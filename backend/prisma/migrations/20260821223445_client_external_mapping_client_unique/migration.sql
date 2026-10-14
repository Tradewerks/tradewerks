/*
  Warnings:

  - A unique constraint covering the columns `[provider,client_id,account_id]` on the table `client_external_mapping` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "client_external_mapping_provider_client_id_account_id_key" ON "client_external_mapping"("provider", "client_id", "account_id");
