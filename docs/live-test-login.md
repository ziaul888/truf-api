# Fixed OTP for one live test customer

Set these environment variables on the Render **backend** service, then deploy/restart it:

```dotenv
LIVE_TEST_PHONE=+8801799009901
LIVE_TEST_OTP=<your-private-8-to-10-digit-code>
```

Both values are required together. Use a dedicated test number with no real customer history. `LIVE_TEST_PHONE` must include `+` and the country code; the portal accepts the equivalent local number (`01799009901`). Choose a private code rather than publishing it in the frontend, `.env.example`, or Git. Keep the global `TEST_OTP_CODE` unset in production; it remains development/test-only.

The normal portal sign-in form works without changes. For this number, **Send code** returns successfully without sending an SMS; enter the configured fixed code. Only that exact number uses this code. Other customers continue through Twilio Verify. No Twilio credentials are needed for the dedicated test number.

The customer cookie, rate limits, profile step, phone-bound bookings and staff authorization stay the same. This is a normal customer account: its bookings use live availability and normal payment rules, and anyone with its code can see that number's bookings. Its live profile is created on the usual profile step; local profiles do not sync to production.

To disable new test logins, remove **both** variables and restart the backend. Existing sessions follow normal expiry; signing this test customer out revokes its sessions on every device.

No migration or frontend setting is required. For a local preview of the allowlisted flow, set the same pair on the local backend and use the fixed live-test code for that number; the existing development-wide `TEST_OTP_CODE` still applies to other local numbers.
