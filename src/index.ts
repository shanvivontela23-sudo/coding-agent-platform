export { gates, runLimits } from "./config/gates.js";
export {
  runResultSchema,
  type RunResult,
} from "./domain/run-result.js";
export {
  commitShaSchema,
  developmentTaskSchema,
  heldOutTaskArtifactPayloadSchema,
  heldOutTaskSchema,
  sealedArtifactSchema,
  taskSchema,
  type BenchmarkTask,
  type DevelopmentBenchmarkTask,
  type HeldOutBenchmarkTask,
  type HeldOutTaskArtifactPayload,
} from "./domain/task.js";
export {
  adversarialCaseSchema,
  adversarialExpectedBehaviorByKind,
  adversarialExpectedBehaviorSchema,
  adversarialKindSchema,
  type AdversarialCase,
  type AdversarialExpectedBehavior,
  type AdversarialKind,
} from "./domain/adversarial-case.js";
export {
  datasetManifestSchema,
  type DatasetManifest,
} from "./domain/dataset.js";
export {
  validateDatasetManifest,
  type DatasetValidationIssue,
  type DatasetValidationResult,
} from "./dataset/validate.js";

export {
  E2BSandboxProvider,
  type E2BSandboxProviderOptions,
} from "./sandbox/e2b-provider.js";
export {
  defaultDependencyHosts,
  networkPolicyForPhase,
  toE2BNetwork,
} from "./sandbox/network-policy.js";
export {
  buildArchiveVerificationCommand,
  buildPatchExportCommand,
  buildRepositoryBootstrapCommand,
  buildStatusCommand,
  sandboxArchivePath,
  sandboxMetadataPath,
  sandboxWorkspacePath,
  validatePinnedRepositoryArchive,
} from "./sandbox/repository-bootstrap.js";
export type {
  PinnedRepositoryArchive,
  SandboxCommand,
  SandboxCommandResult,
  SandboxCreateRequest,
  SandboxNetworkPhase,
  SandboxNetworkPolicy,
  SandboxPatch,
  SandboxProvider,
  SandboxSession,
  SandboxSnapshot,
} from "./sandbox/types.js";
