-- Missions (docs/missions.md), named Initiative in code: ongoing work delegated to a teammate,
-- its planned actions, what went out and its declared number. Only adds.
-- CreateEnum
CREATE TYPE "InitiativeActionStatus" AS ENUM ('planned', 'awaiting_approval', 'declined', 'expired', 'fired', 'cancelled');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "initiativeId" TEXT;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "initiativeId" TEXT;

-- CreateTable
CREATE TABLE "Initiative" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "metricLabel" TEXT,
    "metricUnit" TEXT,
    "metricTarget" DOUBLE PRECISION,
    "createdByMemberId" TEXT,
    "createdByTeammateId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Initiative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitiativeAction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "initiativeId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "draft" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "approveBy" TIMESTAMP(3),
    "status" "InitiativeActionStatus" NOT NULL DEFAULT 'planned',
    "ticketId" TEXT,
    "decidedByMemberId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "firedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InitiativeAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitiativeOutput" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "initiativeId" TEXT NOT NULL,
    "sessionId" TEXT,
    "teammateId" TEXT,
    "actionId" TEXT,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "url" TEXT,
    "summary" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "metricsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InitiativeOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitiativeValue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "initiativeId" TEXT NOT NULL,
    "teammateId" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InitiativeValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Initiative_workspaceId_archivedAt_idx" ON "Initiative"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "InitiativeAction_status_dueAt_idx" ON "InitiativeAction"("status", "dueAt");

-- CreateIndex
CREATE INDEX "InitiativeAction_status_approveBy_idx" ON "InitiativeAction"("status", "approveBy");

-- CreateIndex
CREATE INDEX "InitiativeAction_initiativeId_dueAt_idx" ON "InitiativeAction"("initiativeId", "dueAt");

-- CreateIndex
CREATE INDEX "InitiativeOutput_initiativeId_at_idx" ON "InitiativeOutput"("initiativeId", "at");

-- CreateIndex
CREATE INDEX "InitiativeValue_initiativeId_at_idx" ON "InitiativeValue"("initiativeId", "at");

-- CreateIndex
CREATE INDEX "Session_initiativeId_idx" ON "Session"("initiativeId");

-- CreateIndex
CREATE INDEX "Schedule_initiativeId_idx" ON "Schedule"("initiativeId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeAction" ADD CONSTRAINT "InitiativeAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeAction" ADD CONSTRAINT "InitiativeAction_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeAction" ADD CONSTRAINT "InitiativeAction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeOutput" ADD CONSTRAINT "InitiativeOutput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeOutput" ADD CONSTRAINT "InitiativeOutput_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeOutput" ADD CONSTRAINT "InitiativeOutput_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeOutput" ADD CONSTRAINT "InitiativeOutput_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "InitiativeAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeValue" ADD CONSTRAINT "InitiativeValue_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeValue" ADD CONSTRAINT "InitiativeValue_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

