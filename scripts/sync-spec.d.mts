export declare const SPEC_REPOSITORY: string;
export declare const DEFAULT_SPEC_REF: string;
export declare const GENERATOR_SCRIPTS: readonly string[];

export declare function parseSyncArguments(arguments_: readonly string[]): { readonly ref: string };

export declare function describeUnmappedContract(
  document: unknown,
  lock: { readonly inventories?: Readonly<Record<string, readonly string[]>> },
): string[];
