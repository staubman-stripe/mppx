import type * as Challenge from '../../../Challenge.js'
import { sdkIdentifier } from '../../../internal/version.js'

/** Builds Stripe metadata used to identify and analyze MPP payments. */
export function buildAnalytics(parameters: {
  challenge: Pick<Challenge.Challenge, 'id' | 'intent'>
}): Record<string, string> {
  const { challenge } = parameters
  return {
    mpp_challenge_id: challenge.id,
    mpp_intent: challenge.intent,
    mpp_sdk: sdkIdentifier,
  }
}
