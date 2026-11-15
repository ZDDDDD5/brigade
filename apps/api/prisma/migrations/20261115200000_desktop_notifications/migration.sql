-- Brigade.app as a device that shows the person's notifications (src/notifications.ts), and the
-- pushes queued for it until it fetches them (src/routes/desktop-notifications.ts).
CREATE TABLE "DesktopDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "platform" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DesktopMessage" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "message" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopDevice_tokenHash_key" ON "DesktopDevice"("tokenHash");
CREATE INDEX "DesktopDevice_userId_idx" ON "DesktopDevice"("userId");
CREATE INDEX "DesktopMessage_deviceId_createdAt_idx" ON "DesktopMessage"("deviceId", "createdAt");

ALTER TABLE "DesktopDevice" ADD CONSTRAINT "DesktopDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesktopMessage" ADD CONSTRAINT "DesktopMessage_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DesktopDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
