export type PatchSafetyLimits = {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly blockedCiPaths?: readonly string[];
};

export type PatchSafetyResult = {
  readonly files: readonly string[];
  readonly bytes: number;
  readonly dependencyChanged: boolean;
  readonly lockfileChanged: boolean;
  readonly secretFindings: readonly string[];
};

export function inspectPatchSafety(_patch: string, _limits: PatchSafetyLimits): PatchSafetyResult {
  throw new Error("B2 patch safety is not implemented");
}
