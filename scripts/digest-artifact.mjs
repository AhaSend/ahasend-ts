#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SELF_DIGEST_FIELDS = new Set(["digest", "sha256"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function assertValidString(value, location) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new TypeError(`JCS cannot serialize a lone surrogate at ${location}`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`JCS cannot serialize a lone surrogate at ${location}`);
    }
  }
}

function serialize(value, location, ancestors) {
  if (value === null || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "string") {
    assertValidString(value, location);
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`JCS cannot serialize a non-finite number at ${location}`);
    }
    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError(`JCS cannot serialize ${typeof value} at ${location}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`JCS cannot serialize a cyclic value at ${location}`);
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`JCS cannot serialize a sparse array at ${location}`);
        }
        items.push(serialize(value[index], `${location}[${index}]`, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`JCS can only serialize JSON objects at ${location}`);
    }

    const keys = Object.keys(value).sort();
    const properties = [];

    for (const key of keys) {
      assertValidString(key, `${location} property name`);
      if (SELF_DIGEST_FIELDS.has(key)) {
        throw new TypeError(`Artifact contains forbidden self-digest field ${JSON.stringify(key)}`);
      }
      properties.push(
        `${JSON.stringify(key)}:${serialize(value[key], `${location}.${key}`, ancestors)}`,
      );
    }

    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Return RFC 8785 JSON Canonicalization Scheme bytes. */
export function canonicalizeJson(value) {
  return Buffer.from(serialize(value, "$", new WeakSet()), "utf8");
}

/** Return a detached, lowercase hexadecimal SHA-256 digest. */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Canonicalize and digest a governed JSON artifact. */
export function digestJsonArtifact(value) {
  return sha256Hex(canonicalizeJson(value));
}

/** Digest the exact committed bytes of a UTF-8 YAML artifact. */
export function digestYamlArtifact(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  utf8Decoder.decode(buffer);
  return sha256Hex(buffer);
}

/** Digest a governed .json, .yaml, or .yml artifact from disk. */
export async function digestArtifactFile(filePath) {
  const bytes = await readFile(filePath);
  const extension = extname(filePath).toLowerCase();

  if (extension === ".json") {
    const source = utf8Decoder.decode(bytes);
    return digestJsonArtifact(JSON.parse(source));
  }
  if (extension === ".yaml" || extension === ".yml") {
    return digestYamlArtifact(bytes);
  }

  throw new TypeError(`Unsupported artifact extension ${JSON.stringify(extension)}`);
}

async function main() {
  const [filePath, ...extraArguments] = process.argv.slice(2);
  if (filePath === undefined || extraArguments.length > 0) {
    throw new TypeError("Usage: node scripts/digest-artifact.mjs <artifact.json|artifact.yaml>");
  }

  process.stdout.write(`${await digestArtifactFile(resolve(filePath))}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`digest-artifact: ${message}\n`);
    process.exitCode = 1;
  });
}
