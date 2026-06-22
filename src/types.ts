export const PROTOCOL_VERSION = 2;
export const STORE_VERSION = 2;
export const MIN_READER_VERSION = 1;

export const THREAD_MANAGER_NAME = "pi-thread-manager";

export type ThreadStatus =
	| "creating"
	| "starting"
	| "idle"
	| "running"
	| "stopping"
	| "stopped"
	| "failed"
	| "crashed"
	| "kill_failed"
	| "orphan_needs_manual_action";

export type ThreadAction =
	| "handshake"
	| "status"
	| "list"
	| "create"
	| "read"
	| "send"
	| "follow_up"
	| "steer"
	| "abort"
	| "stop"
	| "cleanup"
	| "schedule"
	| "approvals"
	| "approve"
	| "deny"
	| "review_loop";

export type OperationKind =
	| "create_thread"
	| "send"
	| "follow_up"
	| "steer"
	| "abort"
	| "stop"
	| "cleanup_worktree"
	| "schedule_run"
	| "approval"
	| "child_ui_request"
	| "commit_push_delivery"
	| "review_loop";

export type OperationStatus =
	| "intent_recorded"
	| "external_action_attempted"
	| "acknowledged"
	| "running"
	| "approval_required"
	| "cancelled"
	| "completed"
	| "failed"
	| "unknown_after_restart"
	| "reconciled"
	| "manual_action_required";

export type RestartMode = "never" | "manual" | "from_session";

export interface RestartPolicy {
	mode: RestartMode;
	maxRestarts: number;
	backoffSeconds: number;
	allowWhenOperationUnknown: boolean;
}

export type ExtensionLoadingPolicy = "inherit" | "default" | "none";
export type ApprovalMode = "inherit" | "ask" | "read_only";
export type WorktreeMode = "isolated_required" | "shared_cwd_allowed" | "read_only";

export interface LaunchProfile {
	cwd: string;
	model?: string;
	name?: string;
	extensionLoading: ExtensionLoadingPolicy;
	approvalMode: ApprovalMode;
	inheritedFromParent: boolean;
}

export interface SafetyPolicy {
	worktreeMode: WorktreeMode;
	queuePolicy: "reject_when_running" | "allow_follow_up";
	githubWritePolicy: "ask" | "allow_scoped" | "deny";
	forceKillPolicy: "deny" | "allow_non_windows";
	restartPolicy: RestartPolicy;
}

export type WorktreeAllocationState = "reserved" | "allocated" | "allocation_failed";
export type WorktreeCleanupState = "not_applicable" | "retained" | "cleanup_pending" | "removed" | "manual_action_required";

export type ThreadWorktree =
	| {
			mode: "legacy_shared_cwd";
			sourceCwd: string;
			cleanupState: "not_applicable";
	  }
	| {
			mode: "isolated";
			sourceCwd: string;
			sourceRepoRoot: string;
			sourceSubdir: string;
			primaryRepoRoot: string;
			worktreeRoot: string;
			executionCwd: string;
			branchName: string;
			baseRef: string;
			baseSha: string;
			allocationState: WorktreeAllocationState;
			cleanupState: Exclude<WorktreeCleanupState, "not_applicable">;
			allocatedAt?: string;
			cleanedAt?: string;
			lastCheckedAt?: string;
			lastError?: string;
	  };

export interface CapabilityToken {
	id: string;
	secret: string;
	clientId: string;
	actions: ThreadAction[] | "all";
	threadIds?: string[];
	cwdRoots?: string[];
	expiresAt?: string;
	revokedAt?: string;
}

export interface ManagedThread {
	id: string;
	name?: string;
	parentThreadId?: string;
	status: ThreadStatus;
	cwd: string;
	model?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	createdBy: string;
	lastActivityAt?: string;
	pid?: number;
	pidStartedAt?: string;
	launchNonce?: string;
	restartCount?: number;
	restartBackoffUntil?: string;
	sessionFile?: string;
	logFile?: string;
	lastError?: string;
	currentOperationId?: string;
	launchProfile: LaunchProfile;
	safetyPolicy: SafetyPolicy;
	worktree?: ThreadWorktree;
}

export interface ThreadOperation {
	id: string;
	kind: OperationKind;
	status: OperationStatus;
	threadId?: string;
	idempotencyKey: string;
	createdAt: string;
	updatedAt: string;
	requestId?: string;
	externalId?: string;
	message?: string;
	error?: string;
	approvalId?: string;
	recoveryAction?: "retry" | "manual" | "ignore";
}

export interface ApprovalScope {
	repo?: string;
	prNumber?: number;
	headSha?: string;
	branch?: string;
	actionType: "push" | "reply" | "resolve_thread" | "force_kill";
	threadIds: string[];
	reviewThreadIds?: string[];
	diffSummary?: string;
}

export interface ApprovalRecord {
	id: string;
	status: "pending" | "approved" | "denied" | "expired" | "invalidated";
	scope: ApprovalScope;
	operationId: string;
	createdAt: string;
	expiresAt: string;
	resolvedAt?: string;
	approver?: string;
	reason?: string;
}

export interface JobLease {
	daemonEpoch: string;
	nonce: string;
	expiresAt: string;
	renewedAt: string;
}

export interface AutomationJob {
	id: string;
	type: "review_loop" | "custom";
	status: "scheduled" | "running" | "paused" | "completed" | "failed";
	threadIds: string[];
	target?: Record<string, unknown>;
	intervalSeconds: number;
	lastRunAt?: string;
	nextRunAt?: string;
	lease?: JobLease;
	backoffUntil?: string;
	maxIterations: number;
	iterationCount: number;
	restartPolicy: RestartPolicy;
	createdAt: string;
	updatedAt: string;
	lastError?: string;
}

export interface JobRunRecord {
	id: string;
	jobId: string;
	leaseNonce?: string;
	status: "running" | "completed" | "failed" | "cancelled";
	inputHeadSha?: string;
	reviewThreadIds: string[];
	dispatchedThreadId?: string;
	approvalId?: string;
	result?: string;
	terminalReason?: string;
	retryCount: number;
	idempotencyKey: string;
	createdAt: string;
	updatedAt: string;
}

export interface CommitPushDelivery {
	id: string;
	operationId: string;
	status: "pending" | "approval_required" | "approved" | "pushed" | "failed" | "cancelled";
	repo: string;
	branch: string;
	expectedHeadSha: string;
	diffSummary: string;
	cleanWorktreeRequired: boolean;
	approvalId?: string;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface ThreadStoreDocument {
	storeVersion: typeof STORE_VERSION;
	minReaderVersion: typeof MIN_READER_VERSION;
	createdAt: string;
	updatedAt: string;
	migrationHistory: string[];
	pausedReason?: string;
	threads: Record<string, ManagedThread>;
	operations: Record<string, ThreadOperation>;
	schedules: Record<string, AutomationJob>;
	approvals: Record<string, ApprovalRecord>;
	jobRuns: Record<string, JobRunRecord>;
	commitPushDeliveries: Record<string, CommitPushDelivery>;
}

export interface ProtocolLimits {
	maxFrameBytes: number;
	maxPromptBytes: number;
	maxNameBytes: number;
	maxTagBytes: number;
	maxRequestIdBytes: number;
	maxReadLimit: number;
	maxQueueDepth: number;
	maxThreads: number;
	maxJobs: number;
	minScheduleIntervalSeconds: number;
}

export const DEFAULT_PROTOCOL_LIMITS: ProtocolLimits = {
	maxFrameBytes: 1024 * 1024,
	maxPromptBytes: 256 * 1024,
	maxNameBytes: 120,
	maxTagBytes: 64,
	maxRequestIdBytes: 120,
	maxReadLimit: 200,
	maxQueueDepth: 20,
	maxThreads: 100,
	maxJobs: 100,
	minScheduleIntervalSeconds: 10,
};

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
	mode: "manual",
	maxRestarts: 0,
	backoffSeconds: 30,
	allowWhenOperationUnknown: false,
};

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
	worktreeMode: "isolated_required",
	queuePolicy: "reject_when_running",
	githubWritePolicy: "ask",
	forceKillPolicy: "deny",
	restartPolicy: DEFAULT_RESTART_POLICY,
};

export interface HandshakeRequest {
	type: "handshake";
	id: string;
	protocolVersion: number;
	token?: string;
}

export type BrokerRequest =
	| HandshakeRequest
	| {
			type: "request";
			id: string;
			command: ThreadAction;
			token?: string;
			params?: Record<string, unknown>;
		};

export type BrokerResponse<T = unknown> =
	| { type: "response"; id: string; command?: ThreadAction; success: true; data?: T }
	| { type: "response"; id: string; command?: ThreadAction; success: false; error: string };

export interface CommandLegality {
	allowed: boolean;
	reason?: string;
}

export interface CreateThreadInput {
	name?: string;
	cwd: string;
	model?: string;
	initialPrompt?: string;
	tags?: string[];
	createdBy: string;
	parentThreadId?: string;
	worktreeMode?: WorktreeMode;
	baseRef?: string;
	launchProfile?: Partial<LaunchProfile>;
	safetyPolicy?: Partial<SafetyPolicy>;
}

export interface ThreadReadResult {
	threadId: string;
	cursor: number;
	nextCursor: number;
	items: unknown[];
	truncated: boolean;
}

export interface DaemonStatus {
	protocolVersion: number;
	daemonPid: number;
	daemonEpoch: string;
	storePath: string;
	threadCount: number;
	activeThreadCount: number;
	orphanThreadCount: number;
	isolatedThreadCount?: number;
	legacySharedCwdThreadCount?: number;
	cleanupPendingWorktreeCount?: number;
	worktreeManualActionCount?: number;
	pendingOperationCount: number;
	pendingApprovalCount: number;
	activeScheduleCount: number;
	pausedReason?: string;
}
