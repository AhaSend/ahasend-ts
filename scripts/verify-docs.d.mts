export const REQUIRED_DOCUMENT_PATHS: readonly string[];

export function loadDocumentation(root?: string): Promise<Record<string, string>>;

export function verifyDocumentation(documents: Readonly<Record<string, string>>): void;

export function verifySafeOutput(label: string, source: string): void;

export interface DocumentationSource {
  readonly path: string;
  readonly line: number;
  readonly source: string;
}

export interface DocumentationLink {
  readonly path: string;
  readonly line: number;
  readonly target: string;
}

export interface DocumentationIndex {
  readonly documents: Readonly<Record<string, string>>;
  readonly commands: readonly DocumentationSource[];
  readonly links: readonly DocumentationLink[];
  readonly snippets: readonly (DocumentationSource & { readonly language: string })[];
  readonly examples: readonly { readonly path: string; readonly source: string }[];
  readonly supportingExamples: readonly { readonly path: string; readonly source: string }[];
  readonly nodeSamples: Readonly<
    Record<string, { readonly lang: "javascript"; readonly label: string; readonly source: string }>
  >;
  readonly profileSummary: {
    readonly operations: number;
    readonly iterators: number;
  };
}

export function buildDocumentationIndex(root?: string): Promise<DocumentationIndex>;

export function verifyDocumentationIndex(index: DocumentationIndex, root?: string): Promise<void>;

export const INSTALLED_EXTERNAL_URLS: readonly string[];

export interface InstalledExternalResponse {
  readonly status: number;
  readonly location?: string | null;
}

export interface InstalledLinkVerificationOptions {
  readonly externalUrls?: readonly string[];
  readonly request?: (
    url: URL,
    options: { readonly signal: AbortSignal },
  ) => Promise<InstalledExternalResponse>;
  readonly requestCap?: number;
  readonly timeoutMs?: number;
}

export function verifyInstalledLinks(
  documents: Readonly<Record<string, string>>,
  installedPaths: ReadonlySet<string>,
  options?: InstalledLinkVerificationOptions,
): Promise<void>;

export function verifyInstalledDocumentation(
  tarballPath: string,
  expectedChecksum: string,
  root?: string,
  options?: InstalledLinkVerificationOptions,
): Promise<void>;

export function verifyPackagedJavaScript(
  tarballPath: string,
  expectedChecksum: string,
  root?: string,
  nodeSamples?: DocumentationIndex["nodeSamples"],
): Promise<void>;
