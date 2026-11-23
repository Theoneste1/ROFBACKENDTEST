-- Activation per sign-up form (owner 2026-11-23): "by default, no activation should be needed on any registration
-- form; later the admin might add it". One switch per form, off for every form. It replaces the single setting
-- registration.requireEmailVerification, which now reads and writes these switches (its stored row is no longer read).
-- Additive: one column with a default; no existing row or account changes.
ALTER TABLE "FormAvailability" ADD COLUMN "requireEmailVerification" BOOLEAN NOT NULL DEFAULT false;
