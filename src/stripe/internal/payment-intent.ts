import * as z from '../../zod.js'

/** Stripe PaymentIntent options accepted only by server-side method input. */
export const Schema = z.object({
  customer: z.optional(z.string().check(z.minLength(1))),
  hooks: z.optional(
    z.object({
      inputs: z.object({
        tax: z.object({ calculation: z.string() }),
      }),
    }),
  ),
  metadata: z.optional(z.record(z.string(), z.string())),
  receipt_email: z.optional(z.string()),
})

export type Options = z.infer<typeof Schema>
