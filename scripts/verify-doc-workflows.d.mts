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

export interface DocumentedInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface DocumentedWorkflowExecutionPlan {
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

export interface ArtifactDocumentationWorkflowOptions {
  readonly tarballPath: string;
  readonly checksum: string;
  readonly sourceReportPath: string;
  readonly sourceReportSidecarPath: string;
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
