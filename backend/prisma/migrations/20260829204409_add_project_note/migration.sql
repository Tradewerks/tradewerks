-- CreateTable
CREATE TABLE "project_note" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "project_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "creator_tech_id" TEXT,
    "creator_dispatcher_id" TEXT,
    "last_editor_tech_id" TEXT,
    "last_editor_dispatcher_id" TEXT,
    "notify_technician" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "project_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_note_photo" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "photo_url" TEXT NOT NULL,
    "photo_label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_note_photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_note_project_id_idx" ON "project_note"("project_id");

-- CreateIndex
CREATE INDEX "project_note_photo_note_id_idx" ON "project_note_photo"("note_id");

-- AddForeignKey
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_creator_tech_id_fkey" FOREIGN KEY ("creator_tech_id") REFERENCES "technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_creator_dispatcher_id_fkey" FOREIGN KEY ("creator_dispatcher_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_last_editor_tech_id_fkey" FOREIGN KEY ("last_editor_tech_id") REFERENCES "technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_last_editor_dispatcher_id_fkey" FOREIGN KEY ("last_editor_dispatcher_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_note_photo" ADD CONSTRAINT "project_note_photo_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "project_note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
