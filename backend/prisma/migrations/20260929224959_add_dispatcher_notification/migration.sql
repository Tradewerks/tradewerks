-- CreateTable
CREATE TABLE "dispatcher_notification" (
    "id" TEXT NOT NULL,
    "dispatcher_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "action_url" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatcher_notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatcher_notification_dispatcher_id_idx" ON "dispatcher_notification"("dispatcher_id");

-- CreateIndex
CREATE INDEX "dispatcher_notification_dispatcher_id_read_at_idx" ON "dispatcher_notification"("dispatcher_id", "read_at");

-- CreateIndex
CREATE INDEX "dispatcher_notification_created_at_idx" ON "dispatcher_notification"("created_at");

-- AddForeignKey
ALTER TABLE "dispatcher_notification" ADD CONSTRAINT "dispatcher_notification_dispatcher_id_fkey" FOREIGN KEY ("dispatcher_id") REFERENCES "dispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "dispatcher" ADD COLUMN "muted_notification_types" TEXT[] DEFAULT ARRAY[]::TEXT[];
