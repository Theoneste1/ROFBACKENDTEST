-- Additive only: indexes for the dashboard and reports. No data is changed.
--   Date-range filters on completed reviews, submissions, published results
--   and result releases; users by role and account state.

-- CreateIndex
CREATE INDEX "MentorReview_returnedAt_idx" ON "MentorReview"("returnedAt");

-- CreateIndex
CREATE INDEX "ResultRelease_publishedAt_idx" ON "ResultRelease"("publishedAt");

-- CreateIndex
CREATE INDEX "Submission_submittedAt_idx" ON "Submission"("submittedAt");

-- CreateIndex
CREATE INDEX "Submission_publishedAt_idx" ON "Submission"("publishedAt");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

