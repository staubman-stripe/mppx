import type * as Challenge from '../../../Challenge.js'
import { sdkIdentifier } from '../../../internal/version.js'
import { machinePaymentMetadata } from '../../internal/constants.js'

/** Builds Stripe metadata used to identify and analyze MPP payments. */
export function buildAnalytics(parameters: {
  challenge?: Pick<Challenge.Challenge, 'id' | 'intent'> | undefined
}): Record<string, string> {
  const { challenge } = parameters
  return {
    ...machinePaymentMetadata,
    mpp_sdk: sdkIdentifier,
    ...(challenge && {
      mpp_challenge_id: challenge.id,
      mpp_intent: challenge.intent,
    }),
  }
}
