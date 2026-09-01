import { describe, expect, test } from 'vp/test'

import { buildAnalytics } from './analytics.js'

const challenge = {
  id: 'challenge_123',
  intent: 'charge',
  realm: 'api.example.com',
} as const

describe('buildAnalytics', () => {
  test('builds payment analytics metadata', () => {
    expect(buildAnalytics({ challenge })).toEqual({
      mpp_challenge_id: 'challenge_123',
      mpp_intent: 'charge',
      mpp_server_id: 'api.example.com',
    })
  })

  test('includes the credential source when present', () => {
    expect(buildAnalytics({ challenge, credential: { source: 'did:example:client' } })).toEqual({
      mpp_challenge_id: 'challenge_123',
      mpp_client_id: 'did:example:client',
      mpp_intent: 'charge',
      mpp_server_id: 'api.example.com',
    })
  })
})
