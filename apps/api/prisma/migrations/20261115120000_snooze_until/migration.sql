-- Snooze: each Later ends at a time. Those already put away come back a week from now, and so
-- do those an API older than Snooze puts away while it still runs.
ALTER TABLE "ThreadLater" ADD COLUMN "until" TIMESTAMP(3) NOT NULL DEFAULT (now() + '7 days'::interval);
-- When it came back: its member's list brings it up for a week after, however old it is.
ALTER TABLE "ThreadLater" ADD COLUMN "returnedAt" TIMESTAMP(3);

CREATE INDEX "ThreadLater_until_idx" ON "ThreadLater"("until");
