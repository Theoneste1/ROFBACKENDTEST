/**
 * Olympiad interests (owner decision 8): the olympiads a student is interested in — any of Mathematics,
 * Computing and Physics. Chosen at registration (POST /auth/register/student, optional for older clients)
 * and edited on the profile (PATCH /me). Information only: interests never create programme membership
 * and never grant permissions.
 */
import { OlympiadSubject } from '../generated/prisma/client.js';

/** The fixed order (and the only values): Mathematics, Computing, Physics. */
export const OLYMPIAD_SUBJECTS: readonly OlympiadSubject[] = ['MATHEMATICS', 'COMPUTING', 'PHYSICS'];

export const OLYMPIAD_SUBJECT_LABELS: Record<OlympiadSubject, string> = {
  MATHEMATICS: 'Mathematics',
  COMPUTING:   'Computing',
  PHYSICS:     'Physics',
};

/** The interests in the fixed order, without duplicates. */
export function canonicalInterests(list: readonly OlympiadSubject[] | null | undefined): OlympiadSubject[] {
  const chosen = new Set(list ?? []);
  return OLYMPIAD_SUBJECTS.filter((s) => chosen.has(s));
}

/** "Mathematics; Physics" (CSV exports); empty when none was chosen. */
export function interestLabels(list: readonly OlympiadSubject[] | null | undefined): string {
  return canonicalInterests(list).map((s) => OLYMPIAD_SUBJECT_LABELS[s]).join('; ');
}
