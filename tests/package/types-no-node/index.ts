// A consumer with `"types": []` and no `@types/node` installed.
//
// This fixture exists for one reason: to keep `@types/node` out of the
// published declarations. Until it existed the only type consumer ran with
// `"types": ["node"]` and `@types/node` on disk, so `Buffer`, a `node:buffer`
// import, and the `NodeJS` namespace could all sit in the shipped `.d.ts`
// unnoticed. With `skipLibCheck: false` here, any of them re-entering the
// public surface fails this compile.
//
// The sibling `types/` fixture covers the other half: that a real `Buffer` and
// a real `process.env` are still accepted through the widened signatures.
import type * as SDK from "@ahasend/sdk";
import { AhaSendClient, optionsFromEnv } from "@ahasend/sdk";
import type {
  ExpressHandler,
  FastifyHandler,
  NextHandler,
  NodeStyleRequest,
  NodeStyleResponse,
  WebhookRawBody,
} from "@ahasend/sdk/webhooks";
import { WebhookVerifier } from "@ahasend/sdk/webhooks";

// `process` is not declared here, so nothing but the structural environment
// type makes these two entry points reachable at all.
const env: SDK.ProcessEnvLike = {
  AHASEND_API_KEY: "aha-sk-package-fixture",
  AHASEND_ACCOUNT_ID: "11111111-1111-4111-8111-111111111111",
  AHASEND_TIMEOUT_MS: undefined,
};
const envOptions: SDK.ClientOptions = optionsFromEnv(env);
declare const envClient: AhaSendClient;
void [envOptions, envClient, AhaSendClient.fromEnv];

// Raw webhook bodies are bytes, not `Buffer`.
const byteBody: WebhookRawBody = new Uint8Array([123, 125]);
const textBody: WebhookRawBody = "{}";
declare const verifier: WebhookVerifier;
verifier.verify({ "webhook-id": "id" }, byteBody);
void verifier.parse(new Headers(), textBody);
void new WebhookVerifier("whsec_dGVzdA==");

const nodeRequest: NodeStyleRequest = { headers: {}, rawBody: new Uint8Array([123, 125]) };
const nodeResponse: NodeStyleResponse = { end: (payload?: string | Uint8Array) => payload };
void [nodeRequest, nodeResponse];

const expressHandler: ExpressHandler = (event, request, response) => {
  void [event, request, response];
};
const fastifyHandler: FastifyHandler = (event, request, reply) => {
  void [event, request, reply];
};
const nextHandler: NextHandler = (event, request) => {
  void [event, request];
  return new Response(null, { status: 204 });
};
void [expressHandler, fastifyHandler, nextHandler];

// The WHATWG globals the SDK does name: these come from the DOM lib, not from
// `@types/node`, and are the documented requirement for consumers.
declare const client: AhaSendClient;
const withResponse: Promise<SDK.AhaSendResponse<SDK.PingResponse>> = client.ping().withResponse();
const fetchOption: SDK.ClientOptions = {
  apiKey: "aha-sk-package-fixture",
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
};
declare const abort: AbortSignal;
const abortOption: SDK.RequestOptions = { signal: abort };
void [withResponse, fetchOption, abortOption];
