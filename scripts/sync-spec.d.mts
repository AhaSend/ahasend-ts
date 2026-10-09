export declare const SPEC_REPOSITORY: string;
export declare const DEFAULT_SPEC_REF: string;
export declare const SPEC_FILES: readonly string[];
export declare const GENERATOR_SCRIPTS: readonly string[];

export declare function parseSyncArguments(arguments_: readonly string[]): { readonly ref: string };

export interface SyncSpecSteps {
  readonly download: (file: string, ref: string) => Promise<string>;
  readonly readLock: () => Promise<{
    readonly inventories?: Readonly<Record<string, readonly string[]>>;
  }>;
  readonly writeFiles: (sources: ReadonlyMap<string, string>) => Promise<void>;
  readonly generate: () => Promise<void>;
}

export declare function writeSpecFiles(
  sources: ReadonlyMap<string, string>,
  root?: string,
): Promise<void>;

export declare function syncSpec(
  options: { readonly ref: string },
  steps?: SyncSpecSteps,
): Promise<void>;

export declare function describeUnmappedContract(
  document: unknown,
  lock: { readonly inventories?: Readonly<Record<string, readonly string[]>> },
): string[];
