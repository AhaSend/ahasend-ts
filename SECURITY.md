# Security policy

## Supported versions and runtimes

Security fixes are released for the latest published minor line. Because the SDK is pre-1.0,
upgrade to the latest 0.x release before reporting a result that may already be fixed.

| Version                    | Security support |
| -------------------------- | ---------------- |
| Latest published 0.x minor | Supported        |
| Older 0.x minors           | Upgrade required |

A report is in scope when it reproduces on a runtime in the maintained blocking inventory: Node.js
at or above the package's `engines` floor of `>=22`, Deno, Bun, Cloudflare workerd without
`nodejs_compat`, and Vercel Edge. The exact versions are listed once, in the README under
[Supported runtimes](https://github.com/AhaSend/ahasend-ts/blob/main/README.md#supported-runtimes),
where `tests/release/ci-policy.test.ts` pins them to the CI jobs that enforce them; restating them
here would only add a second copy to go stale. Runtime versions exercised experimentally ahead of
that inventory, and Node.js below the `engines` floor, are out of scope.

Browsers and browser Service Worker scopes are outside the boundary for a different reason:
`AhaSendClient` refuses to construct there so that a bearer API key cannot reach a client-side
bundle. Re-exposing a key through the documented `dangerouslyAllowBrowser: true` escape hatch is
that flag working as designed rather than a vulnerability, but a way to defeat the refusal without
it is in scope.

The package has two public runtime boundaries: `@ahasend/sdk` for the API client and
`@ahasend/sdk/webhooks` for webhook verification. Both ESM and CommonJS consumers are supported
through the package export map. Deep imports into `dist` are unsupported.

## Reporting a vulnerability

Report suspected vulnerabilities privately to `support@ahasend.com` with the subject
`Security: @ahasend/sdk`. Do not open a public GitHub issue, discussion, or pull request before
coordination.

Include:

- the affected SDK version, Node.js version, module format, and operating system;
- the public import path and the smallest reproducible example;
- expected and observed impact;
- steps to reproduce using synthetic credentials and payloads; and
- any suggested mitigation or patch.

Never send live API keys, webhook secrets, SMTP credentials, message bodies, recipient data, or
production request logs. Revoke and rotate any credential that may have been exposed before
sharing a sanitized report.

We aim to acknowledge a report within three business days and provide an initial assessment within
seven business days. Complex investigations may take longer; we will share status updates and
coordinate a disclosure date when the report is confirmed. These are response targets, not a
service-level agreement.

## Disclosure

Please allow time for diagnosis, a fix, tests, and a release across supported module formats before
public disclosure. We will credit reporters who request attribution and will omit attribution on
request. After a fix is available, release notes will describe affected versions, impact, and
upgrade or mitigation guidance without publishing secrets or unnecessary exploit detail.

General SDK bugs and support questions that contain no sensitive data may be filed at
<https://github.com/AhaSend/ahasend-ts/issues>.
