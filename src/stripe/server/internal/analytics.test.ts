import { describe, expect, test } from 'vp/test'

import { sdkIdentifier } from '../../../internal/version.js'
import { buildAnalytics } from './analytics.js'

const challenge = {
  id: 'challenge_123',
  intent: 'charge',
} as const

describe('buildAnalytics', () => {
  test('builds payment analytics metadata', () => {
    expect(buildAnalytics({ challenge })).toEqual({
      machine_payment: 'true',
      mpp_challenge_id: 'challenge_123',
      mpp_intent: 'charge',
      mpp_sdk: sdkIdentifier,
    })
  })

  test('builds base metadata without a challenge', () => {
    expect(buildAnalytics({})).toEqual({
      machine_payment: 'true',
      mpp_sdk: sdkIdentifier,
    })
  })
})
