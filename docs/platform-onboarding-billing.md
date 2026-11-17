# Platform onboarding and manual subscription billing

The platform console now creates draft businesses, assigns one turf per owner and records manual monthly/yearly software fees. These records are separate from booking Payment rows. There are no default plan prices or payment-provider calls.

## Local status

Migration `20261117120000_platform_onboarding_billing` is applied to local turf_test and turf_dev. Existing business record counts and the platform grant were preserved. No production deployment was performed. See the frontend repository's `docs/platform-onboarding-billing-progress.md` for UI usage and verification.

## Release conditions

Deploy the API and reviewed additive migration before the matching frontend. Before applying it to any other database, check active owner memberships: each user may have only one active owner membership. Resolve existing duplicates deliberately; do not discard memberships automatically. Partial indexes also enforce one current agreement and one issued invoice per agreement.

New businesses remain draft; new identities are inactive and receive no credentials. Existing identities keep their password, role and active state. Payment does not activate an owner or business. Tenant-aware booking/services/jobs and isolation gates must be completed before additional turf businesses can transact.

## Contract

All write endpoints require a dedicated platform session and UUID requestId. Writes recheck the platform grant plus grant/user session versions in a Serializable transaction. A matching retry returns the prior target; changed input, resource, actor or action conflicts. Audit records commit with the write.

Prices use integer poisha in BDT, with positive amount checks. Agreed subscription name/price/version and invoice amount are snapshots. Record-payment accepts method (bkash/nagad/bank_transfer), reference, receivedOn and confirmed=true; amount/currency/administrator come from server state. Only full received payments can be recorded. References are NFKC-normalized, stripped of whitespace and uppercased for per-method uniqueness. Future receipt dates are rejected.

Calendar periods use the original monthly/yearly anchor and Asia/Dhaka today. Payment advances paidThrough in order. Renewals require the preceding payment and no open invoice. Cancellation voids open invoices, preserves paid receipts and any remaining paid period, and does not initiate refunds. Effective expiry is computed at read time without a job.

## Checks

Use only the isolated test database for the full integration suite and migration diff:

```sh
NODE_ENV=test yarn test:e2e --no-file-parallelism
NODE_ENV=test yarn prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

Preserve `Payment_method_reference_key`, all existing settings CHECKs, and the documented owner/agreement/open-invoice partial indexes and billing CHECKs. Never execute a generated diff as an automatic repair. No external provider credentials, test accounts or real payment references belong in source or documentation.
