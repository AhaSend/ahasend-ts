import { canonicalizeJson } from "./digest-artifact.mjs";

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

export function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new TypeError(
      `${label} fields must be canonical: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)}.`,
    );
  }
}

export function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty canonical string.`);
  }
  return value;
}

export function requireHash(value, label) {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase hexadecimal SHA-256 value.`);
  }
  return value;
}

export function sourceBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${label} must be bytes or a UTF-8 string.`);
}

export function decodeUtf8(source, label) {
  try {
    return utf8Decoder.decode(sourceBytes(source, label));
  } catch (error) {
    throw new TypeError(`${label} must be UTF-8.`, { cause: error });
  }
}

export function parseCanonicalJson(source, label) {
  const bytes = sourceBytes(source, label);
  let value;
  try {
    value = JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }

  let canonical;
  try {
    canonical = canonicalizeJson(value);
  } catch (error) {
    if (error instanceof Error && error.message.includes("forbidden self-digest")) {
      throw error;
    }
    throw new TypeError(`${label} is not a canonical JSON payload.`, { cause: error });
  }
  if (!bytes.equals(canonical)) {
    throw new TypeError(`${label} must use RFC 8785 canonical JSON bytes.`);
  }
  return { value: requireObject(value, label), bytes };
}

export function parseSha256Sidecar(source, label) {
  const value = decodeUtf8(source, label);
  if (!/^[0-9a-f]{64}\n$/u.test(value)) {
    throw new TypeError(`${label} must contain one lowercase SHA-256 value and a newline.`);
  }
  return value.slice(0, -1);
}
