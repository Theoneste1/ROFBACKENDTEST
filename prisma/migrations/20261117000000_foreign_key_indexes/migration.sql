-- Additive only: indexes on foreign-key columns that had none (joins, filters,
-- and cascading/RESTRICT checks on delete). No data is changed.

-- CreateIndex
CREATE INDEX "AccountActivationToken_createdById_idx" ON "AccountActivationToken"("createdById");

-- CreateIndex
CREATE INDEX "Assignment_approvedById_idx" ON "Assignment"("approvedById");

-- CreateIndex
CREATE INDEX "Assignment_divisionId_idx" ON "Assignment"("divisionId");

-- CreateIndex
CREATE INDEX "ContentReport_resolvedById_idx" ON "ContentReport"("resolvedById");

-- CreateIndex
CREATE INDEX "CourseResource_divisionId_idx" ON "CourseResource"("divisionId");

-- CreateIndex
CREATE INDEX "CourseResource_uploadedById_idx" ON "CourseResource"("uploadedById");

-- CreateIndex
CREATE INDEX "DiscussionThread_divisionId_idx" ON "DiscussionThread"("divisionId");

-- CreateIndex
CREATE INDEX "DistributionBatch_createdById_idx" ON "DistributionBatch"("createdById");

-- CreateIndex
CREATE INDEX "FileObject_uploadedById_idx" ON "FileObject"("uploadedById");

-- CreateIndex
CREATE INDEX "LiveSession_divisionId_idx" ON "LiveSession"("divisionId");

-- CreateIndex
CREATE INDEX "LiveSession_academicYearId_idx" ON "LiveSession"("academicYearId");

-- CreateIndex
CREATE INDEX "MentorAssignment_divisionId_idx" ON "MentorAssignment"("divisionId");

-- CreateIndex
CREATE INDEX "MentorAssignment_assignedById_idx" ON "MentorAssignment"("assignedById");

-- CreateIndex
CREATE INDEX "MentorReview_assignedById_idx" ON "MentorReview"("assignedById");

-- CreateIndex
CREATE INDEX "MentorReview_decidedById_idx" ON "MentorReview"("decidedById");

-- CreateIndex
CREATE INDEX "ModerationAction_reportId_idx" ON "ModerationAction"("reportId");

-- CreateIndex
CREATE INDEX "ResultRelease_publishedById_idx" ON "ResultRelease"("publishedById");

-- CreateIndex
CREATE INDEX "ReviewEvent_actorId_idx" ON "ReviewEvent"("actorId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_divisionId_idx" ON "StudentEnrollment"("divisionId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_schoolId_idx" ON "StudentEnrollment"("schoolId");

-- CreateIndex
CREATE INDEX "SubmissionRevision_submittedById_idx" ON "SubmissionRevision"("submittedById");

-- CreateIndex
CREATE INDEX "SystemSetting_updatedById_idx" ON "SystemSetting"("updatedById");

