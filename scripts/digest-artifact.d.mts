/// <reference types="node" />

export function canonicalizeJson(value: unknown): Buffer;
export function sha256Hex(bytes: Uint8Array | string): string;
export function digestJsonArtifact(value: unknown): string;
export function digestYamlArtifact(bytes: Uint8Array | string): string;
export function digestArtifactFile(filePath: string): Promise<string>;
