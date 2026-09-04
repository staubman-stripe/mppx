# Pre-settlement PaymentIntent option resolution

Status: implemented on the working branch; pending review

Working branch: `staubman/resolved-pi-options`

## Objective

Allow Stripe `paymentIntentOptions` to be either a static object or an asynchronous,
request-scoped resolver, and run the resolver at the latest safe point before a payment
is settled whenever the selected payment method supports that lifecycle.

The primary use case is Stripe Tax for machine payments:

- The initial unauthenticated request must return a 402 without creating a Tax
  Calculation.
- A submitted credential should pass MPPX's challenge checks and, where supported,
  method validation before creating a Tax Calculation.
- An address that Stripe Tax cannot use should stop a server-controlled payment and
  return an actionable HTTP error.
- A successful Tax Calculation must be attached to the PaymentIntent that captures an
  SPT or records a crypto payment.
- Resolver input and output must remain server-only and must never enter the signed
  payment challenge.

This can be implemented entirely in Stripe's existing method wrappers. It does not
require a new MPPX core lifecycle hook.

## Background

Stripe Tax requires a Tax Calculation ID when the PaymentIntent is created. Creating
that calculation before issuing the initial 402 is undesirable because many initial
requests never become paid requests, and Calculation API calls are billable.

The first branch implementation made `paymentIntentOptions` accept a function and
resolved it at two different points:

- SPT: inside `src/stripe/server/Charge.ts`, after MPPX authenticates the challenge
  and after Connect settlement resolution, but before PaymentIntent creation.
- Crypto: inside the `onPaymentSuccess` recorder in
  `src/stripe/server/Methods.ts`, after the crypto payment has settled.

The SPT timing is appropriate. The crypto timing is too late for options that must be
validated before accepting payment. If Stripe Tax rejects the address after broadcast,
the payment has already occurred.

The local `taxServer.js` currently works around this by detecting a credential,
calling `mppx.validateCredential()` when the selected method supports it, creating the
Tax Calculation, and passing a static options object into `compose()`. That has the
right broad ordering but requires applications to inspect method capabilities and
understand MPPX lifecycle details.

## Key observation

`withPaymentIntentInput()` in `src/stripe/server/Methods.ts` already wraps the
underlying rail's `validate`, `broadcast`, and legacy `verify` functions.

MPPX core already invokes split methods in this order:

```text
method.validate()
→ method.broadcast()
```

Therefore, resolving options at the beginning of the wrapper's `broadcast()` gives
the desired ordering automatically:

```text
underlying validate
→ wrapped broadcast begins
→ resolve paymentIntentOptions
→ underlying broadcast
→ payment.success recording
```

For a method that only exposes legacy `verify`, resolve at the beginning of the
wrapper's `verify()`:

```text
wrapped verify begins
→ resolve paymentIntentOptions
→ underlying verify
```

No MPPX core changes or new generic hooks are necessary.

## Decisions already made

1. Keep the object-or-resolver API. It follows the existing Stripe Connect resolver
   precedent and is useful beyond Tax.
2. Resolve as late as possible. All core challenge checks, method validation, and
   other existing preparation should happen first when their lifecycle permits it.
3. Use non-mutating validation only. `mppx.validateCredential()` is non-mutating;
   `verifyCredential()` aliases broadcast and must not be used as preflight validation.
4. Do not require every method to expose `validate`. Stripe SPT has no independent,
   non-consuming verification API, and legacy methods combine validation and payment.
5. Keep Stripe-only values server-side. The resolver function and its output must be
   omitted from the canonical method request and signed challenge.
6. Preserve static-object behavior and backward compatibility.
7. Keep the shared resolver's `request` type as `Record<string, unknown>` for now.
   More precise method-generic typing is desirable but explicitly out of scope.
8. Remove `receipt` from the resolver context. No receipt exists at the required
   pre-broadcast point. Receipt-dependent work belongs in `onPaymentSuccess`.
9. Use MPPX errors inside the resolver. A caller-input problem should throw
   `Errors.BadRequestError`, not a framework-specific exception such as Hono's
   `HTTPException`.
10. Use the challenge ID as the Stripe Tax idempotency key. Address binding is deferred.

## Required lifecycle behavior

### Split `validate` and `broadcast` methods

Tempo charge exposes both hooks. MPPX core calls the wrapped `validate` hook before the
wrapped `broadcast` hook. The Stripe wrapper must not resolve options in `validate`.

The required sequence is:

```text
MPPX HMAC, expiry, route-binding, and payload checks
→ wrapped validate strips Stripe-only input
→ underlying validate succeeds without mutation
→ wrapped broadcast resolves PaymentIntent options
→ wrapped broadcast replaces the resolver with the resolved object in requestInput
→ wrapped broadcast strips Stripe-only input
→ underlying broadcast settles the payment
→ onPaymentSuccess records the PaymentIntent using the resolved object
```

If validation fails, the resolver and broadcast must not run. If the resolver fails,
the underlying broadcast must not run.

### Combined `verify` methods

For custom rails that expose only legacy `verify`, `withPaymentIntentInput()` must
resolve options immediately before delegating to the underlying `verify` hook.

There is no independent non-mutating validation step in this lifecycle. This is an
inherent limitation of a combined verification/payment API.

### Stripe SPT

SPT uses the dedicated `stripe.charge()` implementation rather than
`withPaymentIntentInput()`. Keep resolution inside `Charge.verify()` with this order:

```text
MPPX HMAC, expiry, route-binding, and payload checks
→ resolve and validate Connect settlement
→ resolve paymentIntentOptions
→ create and confirm the Stripe PaymentIntent
```

This preserves the current branch's desirable Connect-before-Tax ordering.

Stripe does not provide a separate non-consuming SPT verification API. A legitimate
challenge submitted with an invalid SPT can therefore trigger a Tax Calculation before
Stripe rejects the SPT. Challenge-based idempotency and endpoint rate limiting are the
appropriate mitigations.

### Already-settled crypto credentials

Tempo also accepts transaction-hash credentials for payments broadcast elsewhere.
Non-mutating validation observes a transfer that already happened. Resolving before
the wrapper delegates to `broadcast` cannot retroactively make that resolution
pre-payment.

The implementation and guide must describe this accurately. A production integration
needs reconciliation or remediation for an existing transfer that cannot be recorded
with Tax options. Do not claim resolver failure prevented such a transfer.

## Request-local state propagation

The wrapper receives the same route request-input object that MPPX later snapshots as
`payment.success.requestInput`. This object contains the server-only
`paymentIntentOptions` value even though the method request schema strips that field
from the canonical challenge.

At the beginning of wrapped `broadcast` or `verify`:

1. Read the resolver or static object from `context.request.paymentIntentOptions`.
2. Resolve and validate it with `PaymentIntent.resolve()`.
3. Replace only `context.request.paymentIntentOptions` with the resolved static object.
4. Delegate to the underlying method with `paymentIntentOptions` removed, using the
   existing `withoutPaymentIntentOptions()` helper.

The deliberate request-input mutation is request-local. It is not a mutation of:

- `credential.challenge.request`
- The verified envelope's canonical request
- The canonical `payment.success.request`
- Shared method configuration

MPPX later snapshots the mutated route input for `payment.success.requestInput`, so the
crypto recorder can consume the resolved object without a global map, a second resolver
call, or changes to MPPX core.

Only the `paymentIntentOptions` property may be replaced. Never mutate amount,
currency, recipient, method details, or any other canonical field.

Confirm with a test that the request object is mutable and that the same object is used
for the terminal call and success-event input. If an upstream invariant prevents this
mutation, stop and reassess rather than adding shared mutable state. The fallback
design should be an explicit request-local carrier in MPPX, not a process-global map.

## Resolver context

`src/stripe/internal/payment-intent.ts` should continue accepting:

```ts
type OptionsInput = Options | ResolveOptions
```

Use a pre-payment context such as:

```ts
type ResolveOptionsContext = {
  challenge: Challenge.Challenge
  credential: Credential.Credential
  envelope?: Method.VerifiedChallengeEnvelope | undefined
  request: Record<string, unknown>
}
```

The direct SPT call and crypto wrapper both have these fields. `request` is the payment
method request, not the raw HTTP request. Applications can parse an HTTP body before
calling `compose()` and close over the parsed data in the resolver.

Do not include `receipt`; it does not exist before broadcast. Do not add raw HTTP input
as part of this change unless a concrete use case requires it. MPPX core has the input
at runtime, but the terminal method context does not currently expose it.

The resolver's returned value must still be parsed through `PaymentIntent.Schema` so a
function cannot bypass the validation applied to static option objects.

## Stripe implementation details

### `src/stripe/internal/payment-intent.ts`

- Retain `Options`, `OptionsInput`, `InputSchema`, and `resolve()`.
- Update `ResolveOptionsContext` to represent pre-payment data.
- Add credential and optional envelope.
- Remove receipt.
- Keep `request` broad as previously decided.
- Continue validating resolved output with `PaymentIntent.Schema`.

### `src/stripe/server/Charge.ts`

- Keep the existing resolver call inside `Charge.verify()`.
- Preserve Connect settlement resolution before PaymentIntent option resolution.
- Pass `credential` and `envelope` into the resolver context.
- Continue merging Stripe analytics, method metadata, and resolved option metadata in
  the current precedence order.
- Do not allow the resolver to override amount, currency, confirmation, SPT, or other
  Stripe-controlled fields.

### `src/stripe/server/Methods.ts`

Modify `withPaymentIntentInput()` rather than MPPX core.

Add an internal helper conceptually equivalent to:

```ts
async function resolvePaymentIntentOptions<context extends Method.VerifyContext<Method.AnyServer>>(
  context: context,
): Promise<context> {
  const input = context.request.paymentIntentOptions
  const { paymentIntentOptions: _, ...request } = context.request
  const resolved = await PaymentIntent.resolve(input, {
    challenge: context.credential.challenge,
    credential: context.credential,
    envelope: context.envelope,
    request,
  })

  context.request.paymentIntentOptions = resolved
  return context
}
```

This is pseudocode, not copy-ready TypeScript. Use appropriate local types, preserve
optional-property conventions, and avoid `any` where the wrapper can retain types.

Compose hooks as follows:

```ts
validate(context) {
  return baseValidate(withoutPaymentIntentOptions(context))
}

async broadcast(context) {
  await resolvePaymentIntentOptions(context)
  return baseBroadcast(withoutPaymentIntentOptions(context))
}

async verify(context) {
  await resolvePaymentIntentOptions(context)
  return baseVerify(withoutPaymentIntentOptions(context))
}
```

Important details:

- Do not resolve in wrapped `validate`; this keeps `mppx.validateCredential()` pure.
- MPPX chooses `broadcast` when it exists, so a normal split-method payment resolves
  exactly once even though a compatibility `verify` function may also exist.
- Preserve an underlying wrapper/hook if one exists; do not replace unrelated behavior.
- Underlying validate, broadcast, verify, and respond hooks must never see Stripe-only
  options.
- If `paymentIntentOptions` is absent, resolution should be a cheap no-op.

Simplify `createPaymentSuccessHandler()` so it only accepts static resolved options.
Remove post-success resolver invocation, its optional-challenge guard, and the fallback
that records without options when the resolver fails. In a normal composed crypto flow,
the resolver has already succeeded before broadcast.

The handler may defensively ignore an unresolved function if someone invokes the public
`onPaymentSuccess` hook directly, but it must not execute side-effecting resolution
after payment as the normal path.

### `src/stripe/Methods.ts`

Keep `PaymentIntent.InputSchema` so the route input accepts static objects and
functions, while its transform continues to omit `paymentIntentOptions` from canonical
output.

## Error semantics

The resolver executes inside wrapped `broadcast`, wrapped `verify`, or SPT
`Charge.verify()`. These terminal calls already run inside MPPX's normal payment-error
handling.

- A resolver should throw `Errors.BadRequestError` for safe, actionable request errors
  such as an unusable tax location.
- MPPX preserves `PaymentError` instances and serializes their status and RFC 9457
  problem details. `BadRequestError` therefore produces an HTTP 400 response.
- Unexpected resolver errors are sanitized as `InternalPaymentError` with HTTP 500.
  Do not expose raw Stripe errors or address data.
- Hono's `HTTPException` is not an MPPX `PaymentError` and will be sanitized as an
  internal error when thrown from inside the resolver.
- If resolution fails, the underlying terminal hook or SPT PaymentIntent creation must
  not run.

The internal `MethodFn.Response` discriminant remains `status: 402` for challenge-like
responses even when `payment.challenge` is an HTTP `Response` with status 400 or 500.
Applications normally return `payment.challenge`; its actual HTTP status is
authoritative.

## Tax server after implementation

After the wrapper timing is implemented, remove the local credential-inspection and
`validateCredential()` workaround from `taxServer.js` and return to a resolver:

```js
function paymentIntentOptions(address) {
  const parameters = calculationParameters(address)
  return async ({ challenge }) => {
    try {
      const calculation = await stripeClient.tax.calculations.create(parameters, {
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
}

const address = await parseAddress(request)
const options = paymentIntentOptions(address)
const payment = await mppx.compose(
  ['tempo/charge', { amount: '0.50', paymentIntentOptions: options }],
  ['stripe/charge', { amount: '0.50', paymentIntentOptions: options }],
)(request)
```

The same resolver can be supplied to both offers. Credential dispatch invokes only the
selected method's terminal path, and the initial challenge path invokes neither.

## Implementation plan

1. Update resolver context in `src/stripe/internal/payment-intent.ts`.
2. Pass the richer context from SPT `Charge.verify()` without changing Connect order.
3. Add the resolve-before-delegate behavior to wrapped crypto `broadcast` and legacy
   `verify` in `withPaymentIntentInput()`.
4. Ensure the resolved static object is visible in success `requestInput`.
5. Simplify the crypto success recorder to consume only static resolved options.
6. Update unit and type tests.
7. Update the existing changeset rather than adding another changeset for the same
   unreleased feature.
8. Rebuild MPPX and return `taxServer.js` to the resolver form using
   `Errors.BadRequestError`.

Do not modify `src/Method.ts` or `src/server/Mppx.ts` unless testing disproves the
request-object identity/mutability assumption. The expected implementation is
Stripe-only.

## Required tests

### Stripe SPT

- Static option objects remain supported.
- Resolver is not called for the initial 402.
- Resolver is not called for forged challenges, malformed credentials, invalid payloads,
  or route-binding failures.
- Connect resolution and validation occur before resolver execution.
- Resolver output is attached to the PaymentIntent.
- Resolver executes exactly once.
- Invalid resolver output prevents PaymentIntent creation.
- `BadRequestError` prevents PaymentIntent creation and produces HTTP 400.
- A legitimate challenge with an invalid SPT may invoke the resolver; document this
  accepted limitation.

### Stripe crypto wrappers

- Exact order for a split method is `validate → resolver → broadcast`.
- Validation failure prevents resolver execution and broadcast.
- Resolver failure prevents underlying broadcast.
- A method without `validate` runs `resolver → verify`.
- `mppx.validateCredential()` invokes underlying validation but not the resolver.
- Resolver executes exactly once in a normal composed payment.
- Underlying validate, broadcast, verify, and respond never receive
  `paymentIntentOptions`.
- The resolved object, not the function, reaches `onPaymentSuccess` through
  `requestInput`.
- The resolved options reach Stripe PaymentIntent recording after successful broadcast.
- Static option behavior remains unchanged.
- Existing metadata merge precedence remains unchanged.
- Cover transaction, proof, and hash credential behavior where their timing differs.

### Request isolation and security

- Concurrent requests do not observe each other's resolved options.
- Resolver replacement mutates only the current request-input object.
- Neither the resolver nor resolved options appear in the serialized challenge.
- Canonical amount, currency, recipient, and method details remain unchanged.
- A resolver cannot use returned options to override Stripe-controlled PaymentIntent
  fields.

### Type tests

- Direct `stripe.charge()` accepts synchronous and asynchronous resolvers.
- `stripe.create().defaultMethods()` compose inputs accept resolvers.
- Resolver context exposes challenge, credential, envelope, and canonical request.
- Receipt is absent from the pre-payment context.
- Static option object types remain unchanged.

### Tax server smoke tests

- Valid body without credential returns 402 and makes zero Tax calls.
- Invalid Tempo credential fails validation before the resolver.
- Valid signed Tempo transaction credential creates Tax after validation and before
  broadcast.
- Tax-location failure returns HTTP 400 and prevents server-controlled broadcast or SPT
  PaymentIntent creation.
- Valid SPT credential creates Tax and attaches it to the PaymentIntent.
- Retrying the same challenge reuses `mpp_tax_<challenge-id>`.

## Alternatives considered

### Add a generic MPPX preparation hook

Rejected as unnecessary. The Stripe wrapper already intercepts terminal hooks, and
MPPX already provides the correct validate-before-broadcast ordering.

### Always calculate Tax before issuing the challenge

Simple, but creates billable calculations for unpaid initial requests.

### Check for credential presence in application code

This is the current local workaround. It avoids initial-request Tax calls, but every
application must inspect method capabilities and unvalidated SPT credentials can still
trigger calculations.

### Call `verifyCredential()` before calculating Tax

Rejected because it aliases broadcast and can settle the payment.

### Call `validateCredential()` unconditionally

Rejected because methods without non-mutating validation, including SPT, throw a
`VerificationFailedError`.

### Resolve crypto options in `onPaymentSuccess`

This is the current branch behavior. It is too late for Tax or any other option whose
failure must prevent server-controlled settlement.

### Store resolved options by challenge ID

Rejected due to concurrency, cleanup, memory-leak, replay, and multi-process concerns.
The existing request-input object is already the appropriate request-local carrier.

### Invoke the resolver twice and rely on Stripe idempotency

Rejected because it adds API traffic and complicates failure and billing semantics.

### Put the address or calculation in the challenge

Deferred. It changes protocol-visible schemas and is outside this iteration.

## Backward compatibility and rollout

- MPPX is pre-v1; this remains a patch changeset under repository policy.
- Static `paymentIntentOptions` must remain source- and runtime-compatible.
- The resolver is unreleased on the working branch, so changing its context before the
  PR merges does not require a migration notice.
- No MPPX core API surface should change.
- Run formatting, lint, TypeScript build, focused Stripe tests, and all feasible Node
  tests. Chain-backed tests require a working Tempo RPC and should be reported
  separately when unavailable.
- Build the local package before testing `taxServer.js` so the local dependency uses
  the updated `dist` output.

## Definition of done

The work is complete when an initial tax-server request returns 402 without a Tax call;
a valid signed Tempo transaction credential is non-destructively validated before the
resolver and broadcast; an SPT resolver runs after Connect preparation and immediately
before PaymentIntent creation; resolver failures return safe, actionable HTTP errors
and prevent server-controlled settlement; and resolved options reach post-payment
Stripe recording without entering the canonical challenge, running twice, or relying
on shared mutable state.
