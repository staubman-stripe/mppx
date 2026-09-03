# Pre-settlement PaymentIntent option resolution

Status: implementation specification; not yet implemented

Working branch: `staubman/resolved-pi-options`

Current branch head when this document was written: `ac42997`

## Objective

Allow Stripe `paymentIntentOptions` to be either a static object or an asynchronous,
request-scoped resolver while running the resolver at the latest safe point before a
payment is settled whenever the payment method supports that lifecycle.

The primary use case is Stripe Tax for machine payments:

- The initial unauthenticated request should return a 402 without creating a Tax
  Calculation.
- A submitted credential should be authenticated and, where possible, validated
  non-destructively before creating a Tax Calculation.
- An address that Stripe Tax cannot use must stop a server-broadcast payment and
  produce an actionable HTTP error.
- A successful Tax Calculation must be attached to the PaymentIntent that captures
  an SPT or records a crypto payment.
- Resolver output and other Stripe-only input must never enter the signed payment
  challenge.

## Why this work exists

Stripe Tax requires a Tax Calculation ID when the PaymentIntent is created. Creating
the calculation before issuing the initial 402 is undesirable because most initial
requests never become paid requests, and Stripe charges for Calculation API usage.

The first implementation therefore made `paymentIntentOptions` accept a function.
It currently resolves at two different points:

- SPT: inside `src/stripe/server/Charge.ts`, after MPPX validates the signed
  challenge and parses the credential payload, but before Stripe creates the
  PaymentIntent.
- Crypto: inside the `onPaymentSuccess` recorder in
  `src/stripe/server/Methods.ts`, after the crypto payment has settled.

That implementation demonstrates the API shape, but resolving after crypto success
is too late for inputs such as tax location. If Stripe Tax rejects the address, the
payment has already occurred and MPPX can only record the PaymentIntent without Tax
options.

The local `taxServer.js` currently works around this by detecting credentials in the
application, calling `mppx.validateCredential()` when supported, creating the Tax
Calculation, and then passing a static options object to `compose()`. This produces
the desired behavior but leaks method lifecycle and capability checks into every
application.

## Decisions already made

1. Keep the object-or-resolver API. It follows the existing Stripe Connect resolver
   precedent and is useful beyond Tax.
2. Resolve as late as possible. Existing checks and Connect settlement resolution
   should happen before expensive resolver work when their ordering permits it.
3. Use non-mutating validation only. `mppx.validateCredential()` is non-mutating;
   `verifyCredential()` is a deprecated alias for broadcast and must never be used
   as a preflight operation.
4. Do not require every method to implement `validate`. Stripe SPT cannot validate
   an SPT independently of PaymentIntent creation. Legacy `verify` methods also
   combine validation and settlement.
5. Keep resolver values server-side. They must be retained in request-local input,
   stripped from the canonical method request, and omitted from the challenge.
6. Preserve static-object behavior and API compatibility.
7. Keep the shared resolver request type broad for now. The current
   `Record<string, unknown>` type is intentionally accepted even though normal MPPX
   handlers preserve more precise method request types.
8. Do not expose a receipt to a pre-settlement resolver. A receipt does not exist
   before broadcast. Receipt-dependent work belongs in `onPaymentSuccess`.
9. Framework exceptions are not portable. Resolver code running inside MPPX should
   throw an MPPX `PaymentError`, such as `Errors.BadRequestError`, rather than Hono's
   `HTTPException`.

## Payment-method lifecycle constraints

### Split `validate` and `broadcast` methods

Tempo charge implements both hooks. For a signed transaction credential, validation
checks and simulates the transaction without broadcasting it. The desired order is:

```text
MPPX challenge/HMAC/route/payload checks
→ method.validate()
→ resolve server-only PaymentIntent options
→ method.broadcast()
→ record the crypto PaymentIntent using the resolved options
```

If validation or option resolution fails, broadcast must not run.

### Combined `verify` methods

Stripe SPT has no independent, non-consuming verification API. Stripe validates the
SPT as part of PaymentIntent creation. Its desired internal order is:

```text
MPPX challenge/HMAC/route/payload checks
→ resolve and validate Connect settlement
→ resolve server-only PaymentIntent options
→ create/confirm Stripe PaymentIntent with the SPT
```

A legitimate signed challenge containing an invalid SPT can still trigger a Tax
Calculation. There is no way around this without a separate non-consuming Stripe SPT
verification API. Challenge-based idempotency and endpoint rate limiting are the
appropriate mitigations.

### Already-broadcast crypto credentials

Tempo also accepts transaction-hash credentials for payments broadcast elsewhere.
Validation necessarily observes a payment that already happened. No lifecycle hook
can make Tax validation pre-payment in that mode.

The implementation must document this limitation. At minimum, a resolver failure
must not claim that the payment was prevented. A production integration needs a
reconciliation/remediation path for a valid existing transaction that cannot be
recorded with Tax options.

Do not silently assume every `validate` hook means funds have not moved. It only
guarantees that this invocation is non-mutating.

## Proposed MPPX lifecycle hook

Add a generic server-method hook, provisionally named `prepare`, that can replace
server-only request input immediately before the terminal payment operation.

The exact name is open to maintainers, but it must not be confused with the existing
`preflight` hook. `preflight` runs before challenge processing and can return an HTTP
response; this new hook runs only for a credential-bearing terminal payment path.

Suggested types in `src/Method.ts`:

```ts
export type PrepareContext<method extends Method> = VerifyContext<method> & {
  /** Result returned by method.validate(), when the method has one. */
  validation?: Validation<method> | undefined
  /** HTTP input when the active transport is HTTP. */
  input?: globalThis.Request | undefined
}

export type PrepareFn<method extends Method> = (
  context: PrepareContext<method>,
) => MaybePromise<z.input<method['schema']['request']>>
```

Add `prepare?: PrepareFn<method>` to `Method.Server`, `Method.toServer.Options`, and
the relevant plumbing in `src/server/Mppx.ts`.

The return value is a new request input, not a canonical request. This allows a
function-valued `paymentIntentOptions` field to be replaced with its resolved object
without introducing a global map or mutating shared method state.

### Required core ordering

Within the credential-bearing path in `createMethodFn`:

```ts
let validation
if (broadcast && validate)
  validation = await validate({ credential, envelope, request: terminalRequest })

if (prepare)
  terminalRequest = await prepare({
    credential,
    envelope,
    input: input instanceof Request ? input : undefined,
    request: terminalRequest,
    validation,
  })

const terminal = broadcast ?? verify
receipt = await terminal({ credential, envelope, request: terminalRequest })
```

The pseudocode is illustrative. Follow repository formatting and preserve current
failure-event behavior.

When a method has no `validate`, `prepare` runs immediately before `broadcast` or
legacy `verify`. A method may also resolve its data inside `verify` when it needs
method-specific ordering that the generic hook cannot express. Stripe SPT should
retain its resolver inside `Charge.verify()` so Connect resolution remains ahead of
PaymentIntent option resolution.

`mppx.validateCredential()` must not invoke `prepare`; it promises a non-mutating
advisory check and must not create Tax Calculations. The normal composed payment path
and terminal `broadcastCredential()` path should use preparation before settlement
when request-local preparation input is available.

### Canonical-request safety invariant

Preparation must not be allowed to alter the payment represented by the signed
challenge.

After `prepare` returns, parse the returned request input through the method request
schema and verify that its canonical output is equivalent to the canonical request
that was accepted before preparation. Reject changes to amount, currency, recipient,
method details, or any other canonical field.

Stripe-only fields are safe because the Stripe wrappers deliberately strip
`paymentIntentOptions` during the method schema transform. The invariant should be
enforced in MPPX core rather than relying solely on wrapper discipline.

Do not add resolved options to `challenge.request`, serialized headers, stable
bindings, or the verified envelope's canonical request.

### Request-local propagation

Use the prepared request input for:

- The terminal `broadcast` or `verify` call.
- `respond`, subject to existing method wrappers stripping Stripe-only fields.
- `payment.success` context's `requestInput`.

Continue using the original canonical request for:

- The challenge and verified envelope.
- Payment success context's `request`.
- Payment failure reporting and challenge binding.

This lets the existing crypto PaymentIntent recorder read the resolved static options
from `requestInput` without invoking the resolver again.

## Stripe changes

### Shared PaymentIntent option types

`src/stripe/internal/payment-intent.ts` should continue accepting:

```ts
type OptionsInput = Options | ResolveOptions
```

Revise the resolver context for pre-settlement execution:

```ts
type ResolveOptionsContext = {
  challenge: Challenge.Challenge
  credential: Credential.Credential
  envelope?: Method.VerifiedChallengeEnvelope | undefined
  input?: Request | undefined
  request: Record<string, unknown>
  validation?: Method.Validation | undefined
}
```

Remove `receipt`. It cannot be consistently available at the required lifecycle
point. The returned options must still be parsed through `PaymentIntent.Schema` so a
resolver cannot bypass validation applied to static options.

### Stripe SPT

Keep resolution in `src/stripe/server/Charge.ts` rather than configuring the generic
`prepare` hook unless Connect settlement is also moved into preparation.

Required order inside `Charge.verify()`:

1. Resolve the canonical request.
2. Check expiry and credential payload shape.
3. Verify server-bound external ID constraints.
4. Resolve and validate Connect settlement.
5. Resolve `paymentIntentOptions`.
6. Assemble immutable Stripe-controlled PaymentIntent fields and metadata.
7. Create/confirm the PaymentIntent.

This is the current branch's ordering and should remain.

### Crypto and custom rails

Update `withPaymentIntentInput()` in `src/stripe/server/Methods.ts` to configure or
compose the new `prepare` hook:

1. Preserve any underlying method `prepare` hook.
2. Pass the underlying hook a request with Stripe-only fields removed.
3. Run the underlying preparation first.
4. Resolve `paymentIntentOptions` last.
5. Return the prepared underlying request with the resolved static options reattached.

Running the PaymentIntent resolver last preserves the existing preference to defer
expensive Tax work until all earlier method checks and preparation have succeeded.

Simplify `createPaymentSuccessHandler()` back to static option handling. It should no
longer invoke or catch the resolver. The recorder should receive the resolved object
from `requestInput`.

If the resolver fails before a server-broadcast crypto payment, terminal broadcast
must not occur. Do not fall back to recording without Tax options in that case.

For methods whose credential represents an already-settled external transaction,
follow the explicit policy selected during implementation and document it. A
reasonable first implementation is to fail and require reconciliation, matching the
fact that the application cannot retroactively make the address valid. Do not describe
that failure as preventing the already-existing transfer.

## Error semantics

Resolver failures happen after MPPX has authenticated the challenge and, when
available, after method validation.

- A resolver may throw `Errors.BadRequestError` for safe, actionable caller input
  errors such as an unusable tax location.
- MPPX should preserve `PaymentError` instances, emit the existing `payment.failed`
  event, and use the error's HTTP status and RFC 9457 problem details.
- Unexpected errors must remain sanitized as `InternalPaymentError` with HTTP 500;
  do not expose raw Stripe errors or addresses.
- Never recognize or propagate framework-specific exceptions such as Hono's
  `HTTPException` from library code.
- No terminal `broadcast`, legacy `verify`, or Stripe PaymentIntent creation may run
  after preparation fails.

The internal `MethodFn.Response` discriminator may still be `status: 402` while its
`challenge` is an HTTP `Response` with status 400 or 500. Existing application code
returns `payment.challenge`, whose actual HTTP status is authoritative. Do not add
application logic that assumes every `payment.status === 402` response has HTTP
status 402.

## Tax server after the core implementation

Once the lifecycle hook is implemented, remove the credential inspection and
`validateCredential()` workaround from the local `taxServer.js`.

The route should return to this shape:

```js
const address = await parseAddress(request)
const paymentIntentOptions = async ({ challenge }) => {
  try {
    const calculation = await stripeClient.tax.calculations.create(calculationParameters(address), {
      idempotencyKey: `mpp_tax_${challenge.id}`,
    })
    return { hooks: { inputs: { tax: { calculation: calculation.id } } } }
  } catch (error) {
    if (isInvalidTaxLocation(error)) {
      throw new Errors.BadRequestError({
        reason: 'Stripe Tax could not determine a tax location. Check the billing address',
      })
    }
    throw error
  }
}

const payment = await mppx.compose(
  ['tempo/charge', { amount: '0.50', paymentIntentOptions }],
  ['stripe/charge', { amount: '0.50', paymentIntentOptions }],
)(request)
```

The same resolver may be supplied to both offers because credential dispatch invokes
only the selected method's terminal path. The initial 402 path must not call it.

Use the challenge ID as the Tax Calculation idempotency key, as already decided. The
address is intentionally not challenge-bound in this iteration.

## Implementation plan by file

1. `src/Method.ts`
   - Add and document the preparation context and hook types.
   - Add the hook to server and `toServer` types.
   - Ensure exported types preserve method request and credential generics.
2. `src/server/Mppx.ts`
   - Plumb the hook through `Mppx.create()` and `createMethodFn()`.
   - Split validation, preparation, and terminal settlement into explicit phases.
   - Preserve current payment failure events and response conversion.
   - Enforce canonical-request equivalence after preparation.
   - Put the prepared value into success `requestInput` without changing canonical
     `request` or the envelope.
   - Do not call preparation from `validateCredential()`.
3. `src/stripe/internal/payment-intent.ts`
   - Update resolver context for pre-settlement execution.
   - Remove receipt and add credential/envelope/validation context as appropriate.
   - Continue validating resolver return values.
4. `src/stripe/server/Charge.ts`
   - Preserve Connect-before-options ordering.
   - Pass the richer verified context into the resolver.
   - Keep all Stripe-controlled PaymentIntent fields protected from overrides.
5. `src/stripe/server/Methods.ts`
   - Compose preparation in `withPaymentIntentInput()`.
   - Remove post-success resolver execution and its fallback catch.
   - Consume only static resolved options in the PaymentIntent recorder.
   - Update comments to describe pre-settlement behavior.
6. Tests and changeset
   - Update the existing changeset rather than adding a second changeset for the same
     unreleased feature.
   - Update the local tax server only after library tests pass.

## Required tests

### MPPX core

- Preparation is not called for the initial challenge request.
- Preparation is not called for a forged challenge, expired challenge, malformed
  credential, invalid payload, or route-binding mismatch.
- Split lifecycle order is exactly `validate → prepare → broadcast`.
- Validation failure prevents preparation and broadcast.
- Preparation failure prevents broadcast.
- A method without `validate` runs `prepare → verify` or `prepare → broadcast`.
- `validateCredential()` never calls preparation.
- A prepared server-only field reaches terminal request input and success
  `requestInput`.
- Preparation cannot alter canonical amount, currency, recipient, or method details.
- `BadRequestError` from preparation produces HTTP 400 problem details.
- An unexpected preparation error produces a sanitized HTTP 500.
- Payment failure events fire once with the correct challenge and error.

### Stripe SPT

- Static option objects remain supported.
- Resolver is not called on initial 402.
- Resolver is not called for a forged or malformed credential.
- Connect resolution and validation happen before the resolver.
- Resolver output is attached to the PaymentIntent.
- Invalid resolver output prevents PaymentIntent creation.
- `BadRequestError` prevents PaymentIntent creation and produces HTTP 400.
- An invalid SPT with a legitimate challenge may call the resolver but creates no
  successful PaymentIntent; document this accepted limitation.

### Stripe crypto

- Resolver runs after method validation and before broadcast for a signed transaction.
- Resolver failure prevents server broadcast.
- Resolver is invoked once per normal composed payment.
- The resolved object reaches PaymentIntent recording after success.
- The options function and resolved object never reach the underlying rail's validate,
  broadcast, verify, or respond hooks.
- Static objects preserve existing behavior.
- Metadata merging and Stripe fallback behavior unrelated to resolver failure remain
  unchanged.
- Cover the chosen policy for hash/push credentials explicitly.

### Type tests

- Direct `stripe.charge()` accepts synchronous and asynchronous resolvers.
- `stripe.create().defaultMethods()` compose inputs accept the resolver.
- Resolver context exposes the selected public fields.
- Static option object types remain unchanged.

### Tax server smoke tests

- Valid body without credential returns 402 and makes zero Tax calls.
- Malformed or unregistered credential makes zero Tax calls.
- Invalid Tempo credential fails validation before Tax.
- Valid signed Tempo credential creates Tax only after validation and before broadcast.
- Tax-location failure returns HTTP 400 and does not broadcast or create an SPT
  PaymentIntent.
- Valid SPT credential creates Tax and attaches it during PaymentIntent creation.
- Repeating a request with the same challenge ID reuses the same idempotency key.

## Alternatives considered and rejected

### Always calculate Tax before issuing the challenge

Simple and produces direct HTTP errors, but creates billable calculations for every
unpaid initial request.

### Check only for credential presence in application code

This is the current local workaround. It avoids initial-request Tax calls and lets
application errors propagate, but unvalidated credentials can trigger calculations
and every application must understand method capabilities.

### Call `verifyCredential()` before calculating Tax

Rejected because it is mutating. It aliases `broadcastCredential()` and may settle
the payment.

### Call `validateCredential()` unconditionally

Rejected because methods without `validate`, including SPT, throw
`VerificationFailedError` saying non-mutating validation is unsupported.

### Resolve all crypto options in `onPaymentSuccess`

This is the current branch behavior. It is acceptable for best-effort metadata but
too late for Tax validation because payment has already settled.

### Store resolved options in a global map keyed by challenge ID

Rejected due to concurrency, cleanup, memory-leak, replay, and multi-process concerns.
Request-local propagation through the preparation return value is safer.

### Invoke the resolver twice and rely only on Stripe idempotency

Rejected because it adds API traffic, complicates failure semantics, and assumes
idempotent replay has no incremental billing or operational cost.

### Put the address or resolved Tax Calculation in the challenge

Deferred. It would challenge-bind more state but affects protocol-visible request
schemas and was explicitly out of scope for this iteration.

## Backward compatibility and rollout

- MPPX is pre-v1; this remains a patch changeset under repository policy.
- Static `paymentIntentOptions` must remain source- and runtime-compatible.
- The resolver feature is unreleased on the working branch, so changing its context
  from optional receipt to pre-settlement fields does not require a migration notice.
- The generic preparation hook is additive.
- Run formatting, lint, TypeScript build, focused Stripe/core tests, and the full
  feasible Node suite with `VITE_TEMPO_NETWORK=none`. Chain-backed tests require a
  working Tempo RPC and must be reported separately when unavailable.
- Build the local package before exercising `taxServer.js` so its `mppx` dependency
  resolves the updated `dist` output.

## Definition of done

The work is complete when an initial tax-server request returns a 402 without a Tax
call; a valid signed Tempo transaction credential is non-destructively validated,
then causes exactly one Tax resolver execution before broadcast; an SPT resolver runs
after Connect preparation and immediately before PaymentIntent creation; invalid tax
locations return actionable HTTP 400 responses without initiating a server-controlled
payment; and resolved options reach post-payment Stripe recording without entering the
canonical challenge or relying on shared mutable state.
