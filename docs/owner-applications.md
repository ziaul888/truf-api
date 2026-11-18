# Owner application activation

Public turf-owner applications are submitted to `POST /api/v1/owner-applications`.
They remain pending until a platform administrator reviews them.

Applicants first load active plans from `GET /api/v1/owner-applications/plans`. A plan and monthly
or yearly interval are required. The application stores the chosen immutable plan version, so a
later plan price change does not change the agreed amount.

Platform endpoints:

- `GET /api/v1/platform/applications`
- `POST /api/v1/platform/applications/:id/activate`
- `POST /api/v1/platform/applications/:id/reject`

Activation creates an active owner-only `User`, a `draft` tenant, one owner membership, the selected
subscription and its first unpaid invoice in a single serializable, audited command. The owner then
signs in through the shared admin-auth login, which issues an `owner_token`; it never grants legacy
staff access. The turf remains `draft` until its operational onboarding is complete. Manual payment
verification is still required before the invoice is marked paid.

Application passwords are scrypt hashed before storage. The API never returns the hash, and the
application record clears it after activation or rejection. Public request replay is bound to a
keyed input fingerprint, pending email/handle uniqueness is enforced in PostgreSQL, and public
submission is origin checked and rate limited.

Migrations `20261118090000_owner_applications` and `20261118110000_owner_application_plans` are
additive and have been applied only to local `turf_test` and `turf_dev`. Production was not changed.
