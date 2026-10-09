export type ChangeDocumentInput = {
  readonly asked: string;
  readonly changed: string;
  readonly files: readonly string[];
  readonly checks: readonly { readonly name: string; readonly status: string }[];
  readonly reproduceProof: string;
  readonly costUsd: number;
  readonly reviewFocus: string;
};

export function buildChangeDocument(_input: ChangeDocumentInput): string {
  throw new Error("B2 change document is not implemented");
}
