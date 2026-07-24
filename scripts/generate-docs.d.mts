export interface GenerateApiReferenceOptions {
  readonly openApiSource?: string;
  readonly profileSource?: string;
}

export function generateApiReference(options?: GenerateApiReferenceOptions): Promise<string>;
