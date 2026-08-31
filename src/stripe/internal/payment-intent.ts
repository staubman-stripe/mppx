import * as z from '../../zod.js'

/** Stripe PaymentIntent options accepted only by server-side method input. */
export const Schema = z.object({
  customer: z.optional(z.string().check(z.minLength(1))),
  metadata: z.optional(z.record(z.string(), z.string())),
})

export type Options = z.infer<typeof Schema>
