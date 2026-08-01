export interface GenerateApiReferenceOptions {
  readonly openApiSource?: string;
  readonly profileSource?: string;
  readonly clientSource?: string;
}

export function generateApiReference(options?: GenerateApiReferenceOptions): Promise<string>;

export interface GenerateRendererHandoffOptions {
  readonly openApiSource?: string;
}

export interface GeneratedRendererHandoff {
  readonly source: string;
  readonly digest: string;
}

export function generateRendererHandoff(
  options?: GenerateRendererHandoffOptions,
): Promise<GeneratedRendererHandoff>;
