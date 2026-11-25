-- Banking information (owner 2026-11-25): Teachers, Coaches and Head Coaches give their personal and their school's
-- bank details. Additive: one new table, no change to any existing row. Rollback:
-- docs/migrations/20261231000000_user_bank_details.rollback.sql.
CREATE TABLE "UserBankDetails" (
    "userId" TEXT NOT NULL,
    "personalAccountName" TEXT,
    "personalBankName" TEXT,
    "personalAccountNumber" TEXT,
    "schoolAccountName" TEXT,
    "schoolBankName" TEXT,
    "schoolAccountNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBankDetails_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserBankDetails" ADD CONSTRAINT "UserBankDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
