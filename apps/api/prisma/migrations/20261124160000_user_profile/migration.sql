-- Settings › Profile: a picture and a name of the person's own choosing. Only adds, so the API
-- before it keeps working.
ALTER TABLE "User" ADD COLUMN "avatar" TEXT;
ALTER TABLE "User" ADD COLUMN "nameChosen" BOOLEAN NOT NULL DEFAULT false;
