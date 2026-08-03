/// <reference types="node" />

export type DocumentationWorkflowOwner =
  | "source-setup"
  | "installed-package"
  | `source:${"build" | "typecheck" | "lint" | "test" | "coverage" | "format"}`
  | `interactive:${"prism" | "dev" | "test-watch"}`
  | "packed-example-matrix";

export interface DocumentationWorkflowEntry {
  readonly path: string;
  readonly line: number;
  readonly command: string;
  readonly owner: DocumentationWorkflowOwner;
}

export const DOCUMENTED_WORKFLOW_REGISTRY: readonly DocumentationWorkflowEntry[];
export const TSUP_INITIAL_BUILD_MARKERS: readonly RegExp[];

export interface DocumentedInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface DocumentedWorkflowExecutionPlan {
  readonly clone: DocumentedInvocation;
  readonly sourceDirectory: string;
  readonly install: DocumentedInvocation;
  readonly source: readonly {
    readonly owner: `source:${"build" | "typecheck" | "lint" | "test" | "coverage" | "format"}`;
    readonly invocation: DocumentedInvocation;
  }[];
  readonly prism: DocumentedInvocation;
  readonly dev: DocumentedInvocation;
  readonly watch: DocumentedInvocation;
}

export function createDocumentedWorkflowExecutionPlan(
  registry?: readonly DocumentationWorkflowEntry[],
): DocumentedWorkflowExecutionPlan;

export interface DocumentationIndex {
  readonly commands: readonly {
    readonly path: string;
    readonly line: number;
    readonly source: string;
  }[];
}

export function validateDocumentedWorkflowRegistry(
  index: DocumentationIndex,
  registry?: readonly DocumentationWorkflowEntry[],
): { readonly commands: number; readonly owners: number };

export interface BoundedInteractiveOptions {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly marker?: RegExp;
  readonly requiredMarkers?: readonly RegExp[];
  readonly readiness?: () => boolean | Promise<boolean>;
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export function runBoundedInteractive(options: BoundedInteractiveOptions): Promise<string>;

export function runSourceDocumentationWorkflows(root?: string): Promise<{
  readonly commands: number;
  readonly owners: number;
  readonly result: "documentation-workflows";
  readonly passed: true;
}>;

export interface SourceReportSummary {
  readonly commit: string;
  readonly reportDigest: string;
  readonly gates: number;
}

export interface ValidateDocumentationWorkflowEvidenceOptions {
  readonly evidenceSource: string | Uint8Array;
  readonly evidenceSidecar: string | Uint8Array;
  readonly sourceSummary: SourceReportSummary;
}

export function validateDocumentationWorkflowEvidence(
  options: ValidateDocumentationWorkflowEvidenceOptions,
): {
  readonly commit: string;
  readonly evidenceDigest: string;
  readonly result: "documentation-workflows";
  readonly passed: true;
};

export interface DocumentationWorkflowResult {
  readonly result: "documentation-workflows";
  readonly passed: true;
}

export function createDocumentationWorkflowEvidence(
  sourceSummary: SourceReportSummary,
  workflowResult: DocumentationWorkflowResult,
): {
  readonly evidenceSource: Buffer;
  readonly evidenceSidecar: Buffer;
};

export interface ArtifactDocumentationWorkflowOptions {
  readonly tarballPath: string;
  readonly checksum: string;
  readonly sourceReportPath: string;
  readonly sourceReportSidecarPath: string;
  readonly documentationEvidencePath: string;
  readonly documentationEvidenceSidecarPath: string;
  readonly root?: string;
}

export function runArtifactDocumentationWorkflows(
  options: ArtifactDocumentationWorkflowOptions,
): Promise<{
  readonly commands: number;
  readonly owners: number;
  readonly artifact: true;
  readonly passed: true;
}>;
