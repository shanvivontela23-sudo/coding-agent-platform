export type SandboxNetworkPhase =
  | "locked"
  | "dependency-setup"
  | "coding"
  | "testing";

export type SandboxNetworkPolicy = {
  readonly allowHosts: readonly string[];
  readonly denyAllOtherEgress: true;
};

export type PinnedRepositoryArchive = {
  readonly pinnedCommit: string;
  readonly archiveSha256: string;
  readonly archive: Uint8Array;
};

export type SandboxCreateRequest = {
  readonly taskId: string;
  readonly repository: PinnedRepositoryArchive;
  readonly gatewayUrl: string;
  readonly template?: string;
  readonly timeoutMs?: number;
  readonly extraDependencyHosts?: readonly string[];
};

export type SandboxCommand = {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export type SandboxCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

export type SandboxPatch = {
  readonly patch: string;
  readonly status: string;
};

export type SandboxSnapshot = {
  readonly id: string;
};

export interface SandboxSession {
  readonly id: string;
  readonly workspacePath: string;

  exec(command: SandboxCommand): Promise<SandboxCommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string | ArrayBuffer): Promise<void>;
  setNetworkPhase(phase: SandboxNetworkPhase): Promise<void>;
  exportPatch(): Promise<SandboxPatch>;
  snapshot(name?: string): Promise<SandboxSnapshot>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  create(request: SandboxCreateRequest): Promise<SandboxSession>;
}
