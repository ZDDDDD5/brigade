-- AlterTable
ALTER TABLE "SidebarOrder" ADD COLUMN     "layout" JSONB,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "roomId" TEXT,
ADD COLUMN     "roomReady" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "roomRequestHash" TEXT,
ADD COLUMN     "roomStopped" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TeamRoom" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "memberIds" TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TeamRoom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamRoom_workspaceId_memberId_idx" ON "TeamRoom"("workspaceId", "memberId");

-- CreateIndex
CREATE INDEX "Session_roomId_createdAt_idx" ON "Session"("roomId", "createdAt");

-- AddForeignKey
ALTER TABLE "TeamRoom" ADD CONSTRAINT "TeamRoom_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRoom" ADD CONSTRAINT "TeamRoom_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "TeamRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

