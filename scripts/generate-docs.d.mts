export interface GenerateApiReferenceOptions {
  readonly openApiSource?: string;
  readonly profileSource?: string;
  readonly clientSource?: string;
}

export function generateApiReference(options?: GenerateApiReferenceOptions): Promise<string>;
