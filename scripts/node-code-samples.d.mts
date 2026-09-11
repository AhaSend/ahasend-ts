export interface NodeCodeSample {
  readonly lang: "javascript";
  readonly label: string;
  readonly source: string;
}

export interface NodeSampleRegistryEntry {
  readonly operationId: string;
  readonly operationKey: string;
  readonly facade: string;
  readonly sample: NodeCodeSample;
}

export const NODE_SAMPLE_LANGUAGE: "javascript";
export const NODE_SAMPLE_LABEL: string;
export const NODE_SAMPLE_REGISTRY: readonly NodeSampleRegistryEntry[];
export const NODE_OPERATION_KEYS: Readonly<Record<string, string>>;
export const NODE_CODE_SAMPLES: Readonly<Record<string, NodeCodeSample>>;
