export interface RestoreLatestOptions {
  readonly packageName: string;
  readonly previousLatest: string | null;
  readonly attempts?: number;
  readonly delay?: () => void | Promise<void>;
  readonly runNpm?: (args: readonly string[]) => string | Promise<string>;
}

export interface PromoteLatestOptions {
  readonly packageName: string;
  readonly version: string;
  readonly attempts?: number;
  readonly delay?: () => void | Promise<void>;
  readonly runNpm?: (args: readonly string[]) => string | Promise<string>;
}

export function promoteLatest(options: PromoteLatestOptions): Promise<void>;
export function restoreLatest(options: RestoreLatestOptions): Promise<void>;
