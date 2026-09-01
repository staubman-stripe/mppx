import type * as Challenge from '../../../Challenge.js'
import type * as Credential from '../../../Credential.js'

/** Builds Stripe metadata used to identify and analyze MPP payments. */
export function buildAnalytics(parameters: {
  challenge: Pick<Challenge.Challenge, 'id' | 'intent' | 'realm'>
  credential?: Pick<Credential.Credential, 'source'> | undefined
}): Record<string, string> {
  const { challenge, credential } = parameters
  return {
    mpp_intent: challenge.intent,
    mpp_challenge_id: challenge.id,
    mpp_server_id: challenge.realm,
    ...(credential?.source ? { mpp_client_id: credential.source } : {}),
  }
}
