-- The Inbox's Other (src/inbox.ts): mail nobody took that is kept out of To do, and the senders
-- people muted. Only adds a nullable column and a table: the API before it keeps working.
-- AlterTable
ALTER TABLE "MailMessage" ADD COLUMN "noise" TEXT;

-- CreateTable
CREATE TABLE "MailMute" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailMute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailMute_workspaceId_kind_value_key" ON "MailMute"("workspaceId", "kind", "value");

-- AddForeignKey
ALTER TABLE "MailMute" ADD CONSTRAINT "MailMute_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The mail already waiting in To do: what the new delivery would have kept out of it. Mail to a
-- sign-up address whose thread no longer waits, and mail sent by a machine.
UPDATE "MailMessage" m SET "noise" = CASE WHEN m."aliasId" IS NOT NULL THEN 'sign_up' ELSE 'automatic' END
WHERE m."direction" = 'in' AND m."route" = 'box' AND m."routeNote" IS NULL AND m."doneAt" IS NULL
  AND m."sessionId" IS NULL AND m."status" = 'done'
  AND (m."aliasId" IS NOT NULL OR m."automatic" = true);
