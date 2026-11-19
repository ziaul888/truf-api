# Owner application activation

Public turf-owner applications are submitted to `POST /api/v1/owner-applications`.
They remain pending until a platform administrator verifies the first payment.

Applicants load active plans from `GET /api/v1/owner-applications/plans` and receiving instructions
from `GET /api/v1/owner-applications/payment-methods`. Platform administrators manage the public
instructions in Platform → Plans. Blank methods are unavailable. The application requires a billing
interval and the current price and version. Applicants can submit without payment or provide the
transfer method, reference and payment date together. The application retains the selected immutable
plan version until review.

Platform endpoints:

- `GET /api/v1/platform/applications`
- `POST /api/v1/platform/applications/:id/activate` with `confirmed: true` after verifying the full amount. When the application has no proof, include `payment: { method, reference, receivedOn }`.
- `POST /api/v1/platform/applications/:id/reject`

Activation creates an active owner-only `User`, a `draft` tenant, one owner membership, the selected
subscription, paid first invoice and receipt in a single serializable, audited command. The owner then
signs in through the shared admin-auth login, which issues an `owner_token` scoped to the turf.
The billing period starts on the activation date. For pending applications with a selected plan, an
administrator can record verified payment at activation.

Application passwords are scrypt hashed before storage. The API never returns the hash, and the
application record clears it after activation or rejection. Public request replay is bound to a
keyed input fingerprint, pending email/handle uniqueness is enforced in PostgreSQL, and public
submission is origin checked and rate limited.

Migration `20261119090000_prepaid_owner_applications` adds nullable payment proof fields for existing
records and reserves a normalized reference while an application is pending.
