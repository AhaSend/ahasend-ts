export const REQUIRED_DOCUMENT_PATHS: readonly string[];

export function loadDocumentation(root?: string): Promise<Record<string, string>>;

export function verifyDocumentation(documents: Readonly<Record<string, string>>): void;
