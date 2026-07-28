export interface NodeCodeSample {
  readonly lang: "javascript";
  readonly label: string;
  readonly source: string;
}

export const NODE_SAMPLE_LANGUAGE: "javascript";
export const NODE_SAMPLE_LABEL: string;
export const NODE_OPERATION_KEYS: Readonly<Record<string, string>>;
export const NODE_CODE_SAMPLES: Readonly<Record<string, NodeCodeSample>>;
