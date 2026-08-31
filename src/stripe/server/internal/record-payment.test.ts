import { describe, expect, test, vi } from 'vp/test'

import type { StripeClient } from '../../internal/types.js'
import { recordCryptoPayment } from './record-payment.js'

function createClient(create: (...args: any[]) => Promise<any>): StripeClient {
  return { paymentIntents: { create } }
}

describe('recordCryptoPayment', () => {
  test('retries without optional fields after a definitive invalid request', async () => {
    const invalidRequest = Object.assign(new Error('Invalid customer'), {
      type: 'StripeInvalidRequestError',
    })
    const create = vi
      .fn()
      .mockRejectedValueOnce(invalidRequest)
      .mockResolvedValueOnce({ id: 'pi_123', status: 'succeeded' })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await recordCryptoPayment(createClient(create), {
      amount: '500000',
      customer: 'cus_123',
      metadata: { machine_payment: 'custom', request_id: 'req_123' },
      network: 'tempo',
      reference: '0xtx123',
    })

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        customer: 'cus_123',
        metadata: { machine_payment: 'custom', request_id: 'req_123' },
      }),
    )
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('customer')
    expect(create.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ metadata: { machine_payment: 'true' } }),
    )
    expect(create.mock.calls[1]?.[1]).toEqual(create.mock.calls[0]?.[1])
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('retrying without them'),
      invalidRequest,
    )
  })

  test('does not retry after an ambiguous failure', async () => {
    const create = vi.fn().mockRejectedValue(new Error('Connection reset'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await recordCryptoPayment(createClient(create), {
      amount: '500000',
      customer: 'cus_123',
      network: 'tempo',
      reference: '0xtx123',
    })

    expect(create).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(
      '[stripe] failed to record crypto payment:',
      expect.any(Error),
    )
  })
})
