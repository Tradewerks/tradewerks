-- CreateTable
CREATE TABLE "assistant_conversation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_role" TEXT NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "assistant_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_message" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "finish_reason" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_tool_call" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "provider_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error_code" TEXT,
    "duration_ms" INTEGER,
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "assistant_tool_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_conversation_organization_id_user_id_updated_at_idx" ON "assistant_conversation"("organization_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "assistant_conversation_organization_id_updated_at_idx" ON "assistant_conversation"("organization_id", "updated_at");

-- CreateIndex
CREATE INDEX "assistant_message_conversation_id_created_at_idx" ON "assistant_message"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_tool_call_message_id_idx" ON "assistant_tool_call"("message_id");

-- CreateIndex
CREATE INDEX "assistant_tool_call_tool_name_idx" ON "assistant_tool_call"("tool_name");

-- AddForeignKey
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_message" ADD CONSTRAINT "assistant_message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_tool_call" ADD CONSTRAINT "assistant_tool_call_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "assistant_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
