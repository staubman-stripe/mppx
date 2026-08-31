import { machinePaymentMetadata } from '../../internal/constants.js'
import type { StripeClient } from '../../internal/types.js'
import type { stripe } from '../Methods.js'
import { createPaymentIntent, type ConnectConfig } from './request.js'

const NETWORK_CONFIG: Record<stripe.Network, { stripeNetworkName: string; tokenDecimals: number }> =
  {
    tempo: { stripeNetworkName: 'tempo', tokenDecimals: 6 },
    base: { stripeNetworkName: 'base', tokenDecimals: 6 },
    solana: { stripeNetworkName: 'solana', tokenDecimals: 6 },
  }

/**
 * Records a crypto payment as a Stripe PaymentIntent using transaction_verification mode.
 * Errors are logged but never thrown (the returned Promise always resolves).
 */
export function recordCryptoPayment(
  client: StripeClient,
  parameters: {
    network: stripe.Network
    reference: string
    amount: string
    connect?: ConnectConfig
    customer?: string
    metadata?: Record<string, string>
  },
): Promise<void> {
  const { network, reference, amount, connect, customer, metadata } = parameters
  const { stripeNetworkName, tokenDecimals } = NETWORK_CONFIG[network]

  const amountCents = Math.round(Number(amount) / 10 ** (tokenDecimals - 2))
  if (amountCents < 1) {
    console.warn(
      `[stripe] skipping PI recording: ${amount} raw units on ${network} rounds to ${amountCents} cents (below Stripe minimum)`,
    )
    return Promise.resolve()
  }

  return createPaymentIntent(
    client,
    {
      amount: amountCents,
      currency: 'usd',
      confirm: true,
      ...(customer && { customer }),
      payment_method_data: { type: 'crypto' },
      payment_method_types: ['crypto'],
      payment_method_options: {
        crypto: {
          mode: 'transaction_verification',
          transaction_verification_options: {
            network: stripeNetworkName,
            transaction_hash: reference,
          },
        },
      },
      metadata: { ...machinePaymentMetadata, ...metadata },
    },
    {
      idempotencyKey: reference,
      ...(connect && { connect }),
    },
  ).then(
    () => {},
    (err) => {
      console.error('[stripe] failed to record crypto payment:', err)
    },
  )
}
