-- Additive only: a new, empty table. No existing data is changed.
--   NotificationSetting: per-type in-app / e-mail switches admins and mentors
--   choose in their profile settings. No row = both on (the previous behaviour).

-- CreateTable
CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationSetting_type_userId_idx" ON "NotificationSetting"("type", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationSetting_userId_type_key" ON "NotificationSetting"("userId", "type");

-- AddForeignKey
ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

