-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'google_ads';

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN "settings" JSONB;
