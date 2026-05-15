export type GoalType = "github_pr_review";
export type GoalState =
  | "active"
  | "paused"
  | "running"
  | "needs_decision"
  | "failed"
  | "completed"
  | "dormant"
  | "cancelled";

export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  currentMs: number;
}

export interface QuietWindowPolicy {
  durationMs: number;
  onExpire: "completed" | "dormant";
  quietSince?: string;
}

export interface SchedulePolicy {
  nextCheckAt: string;
  backoff: BackoffPolicy;
  quietWindow: QuietWindowPolicy;
  maxAttempts?: number;
  checkIntervalMs?: number;
}

export type WorktreeMode = "isolated" | "same_path";

export interface RepositoryRef {
  owner: string;
  repo: string;
  url?: string;
  localPath?: string;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  worktreeMode?: WorktreeMode;
  worktreeHeadSha?: string;
  pushRemote?: string;
  pushBranch?: string;
}

export interface GithubPrGoalConfig {
  repository: RepositoryRef;
  prNumber: number;
  prUrl?: string;
  validationCommands: string[];
  autoReplyAndResolve: boolean;
  lastObservedAt?: string;
  lastHandledAt?: string;
  handledThreadIds: string[];
  handledCheckNames: string[];
}

export interface GoalRecord {
  schemaVersion: 1;
  id: string;
  type: GoalType;
  state: GoalState;
  createdAt: string;
  updatedAt: string;
  summary: string;
  cwd?: string;
  schedule: SchedulePolicy;
  runHistory: RunSummary[];
  pendingDecisions: DecisionRecord[];
  latestProgress?: string;
  lastRunSummary?: string;
  github?: GithubPrGoalConfig;
}

export interface RunSummary {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "failed" | "timeout" | "needs_decision";
  summary?: string;
  commitSha?: string;
  validationResults?: ValidationResult[];
}

export interface ValidationResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  output?: string;
}

export interface DecisionOption {
  id: string;
  label: string;
}

export interface DecisionRecord {
  id: string;
  goalId: string;
  runId?: string;
  prompt: string;
  options: DecisionOption[];
  createdAt: string;
  timeoutAt?: string;
  status: "pending" | "answered";
  answer?: string;
  answeredAt?: string;
  required: boolean;
}

export type GoalEvent =
  | ProgressEvent
  | DecisionEvent
  | CompleteEvent
  | FailureEvent
  | DiagnosticEvent
  | NotificationEvent;

export interface BaseGoalEvent {
  type: string;
  goalId: string;
  runId?: string;
  timestamp: string;
}

export interface ProgressEvent extends BaseGoalEvent {
  type: "progress";
  message: string;
}

export interface DecisionEvent extends BaseGoalEvent {
  type: "decision";
  decision: DecisionRecord;
}

export interface CompleteEvent extends BaseGoalEvent {
  type: "complete";
  status: "success" | "quiet" | "stale";
  summary: string;
  commitSha?: string;
  validationResults?: ValidationResult[];
  addressedThreadIds?: string[];
}

export interface FailureEvent extends BaseGoalEvent {
  type: "failure";
  message: string;
  retryable: boolean;
}

export interface DiagnosticEvent extends BaseGoalEvent {
  type: "diagnostic";
  message: string;
}

export interface NotificationEvent extends BaseGoalEvent {
  type: "notification";
  sink: string;
  status: "sent" | "failed";
  message: string;
}

export interface ReviewThreadObservation {
  id: string;
  path?: string;
  line?: number;
  outdated?: boolean;
  resolved?: boolean;
  updatedAt?: string;
  comments: Array<{ id: string; body: string; author?: string; url?: string; updatedAt?: string }>;
}

export interface CheckObservation {
  name: string;
  status: "passing" | "failing" | "pending" | "unknown";
  url?: string;
  summary?: string;
  completedAt?: string;
}

export interface GithubObservation {
  observedAt: string;
  prUrl?: string;
  headBranch?: string;
  headSha?: string;
  reviewThreads: ReviewThreadObservation[];
  checks: CheckObservation[];
}

export interface ActionableObservation {
  actionable: boolean;
  observedAt: string;
  threads: ReviewThreadObservation[];
  checks: CheckObservation[];
  reason: string;
}

export interface SchedulerResult {
  checked: number;
  launched: number;
  skipped: number;
  failures: number;
  messages: string[];
}
