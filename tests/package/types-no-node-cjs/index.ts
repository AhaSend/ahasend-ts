// The CommonJS half of the no-@types/node gate.
//
// This package.json deliberately omits `"type": "module"`, so under Node16 /
// NodeNext resolution these imports take the `require` export condition and the
// program loads `dist/index.d.cts` and `dist/webhooks/index.d.cts` — the two
// published declaration files that the ESM fixtures never look at, and that
// nothing else in CI type-checks either (api-extractor reads only the .d.ts
// pair, and the cjs runtime fixture is plain JavaScript).
//
// The entry is deliberately small: `skipLibCheck: false` checks every
// declaration file in the program in full, not merely the parts these imports
// reach, so naming one type per entry point is enough to put both .d.cts files
// under the compiler. See the sibling types-no-node fixture for the ESM half.
import type { AhaSendClient, ClientOptions, ProcessEnvLike } from "@ahasend/sdk";
import type { NodeStyleRequest, WebhookRawBody } from "@ahasend/sdk/webhooks";

declare const client: AhaSendClient;
declare const options: ClientOptions;
declare const env: ProcessEnvLike;
declare const request: NodeStyleRequest;
declare const rawBody: WebhookRawBody;

export type Surface = [typeof client, typeof options, typeof env, typeof request, typeof rawBody];
