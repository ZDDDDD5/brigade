-- Conversions of people who came from a Google ad, sent to Google Ads (src/google-ads.ts).
CREATE TABLE "AdConversion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" DOUBLE PRECISION,
    "currency" TEXT,
    "sendAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "AdConversion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdConversion_userId_kind_key" ON "AdConversion"("userId", "kind");
CREATE INDEX "AdConversion_confirmedAt_failedAt_idx" ON "AdConversion"("confirmedAt", "failedAt");

ALTER TABLE "AdConversion" ADD CONSTRAINT "AdConversion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
