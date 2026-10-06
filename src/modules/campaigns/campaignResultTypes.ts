export type RecipientEligibility =
  | 'eligible'
  | 'missing_phone'
  | 'invalid_phone'
  | 'duplicate_phone'
  | 'opted_out'
  | 'not_on_whatsapp'
  | 'stale_google_contact'
  | 'unknown';

export type RecipientResultCode =
  | 'accepted'
  | 'permanent_failure'
  | 'transient_failure_exhausted'
  | 'validation_failure'
  | 'skipped_opt_out'
  | 'skipped_cancelled';

export type DeletionRecommendation = 'recommended' | 'review' | 'not_recommended';

export interface RecipientResultReason {
  code: RecipientResultCode;
  description: string;
  technicalDetail?: string;
  deletionRecommendation: DeletionRecommendation;
  deletionReasonCode?: string;
}

export function deletionRecommendationFor(
  eligibility: RecipientEligibility,
): DeletionRecommendation {
  switch (eligibility) {
    case 'missing_phone':
    case 'invalid_phone':
    case 'not_on_whatsapp':
      return 'recommended';
    case 'stale_google_contact':
      return 'review';
    case 'eligible':
    case 'duplicate_phone':
    case 'opted_out':
    case 'unknown':
      return 'not_recommended';
  }
}
