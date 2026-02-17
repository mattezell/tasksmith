/**
 * TaskSmith Types & Provider Interfaces
 *
 * These are the contracts. Every provider implements one of these.
 * The engine calls interfaces — never concrete implementations.
 */

// =============================================================================
// ENUMS
// =============================================================================

export enum Priority {
  LOW = "low",
  NORMAL = "normal",
  HIGH = "high",
  URGENT = "urgent",
}

export enum TaskStatus {
  PENDING = "pending",
  ACTIVE = "active",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

// =============================================================================
// DATA TYPES
// =============================================================================

export interface Notification {
  title: string;
  body: string;
  priority: Priority;
  taskId?: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
}

export interface InboundMessage {
  source: string;
  sender: string;
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface MemoryEntry {
  content: string;
  source: string;
  category: string; // general, decision, preference, fact, error, task_result
  importance: number; // 0.0 - 1.0
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  content: string;
  score: number;
  source: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  model: string;
  provider: string;
  tokensUsed?: number;
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  template: string;
  prompt: string;
  project: string;
  params: Record<string, unknown>;
  model: string;
  priority: string;
  maxIterations: number;
  notify: string[];
  status: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  result: string;
  error: string;
  iterations: number;
  sourceFile: string;
}

// =============================================================================
// PROVIDER INTERFACES
// =============================================================================

export type InboundCallback = (msg: InboundMessage) => Promise<void>;

export interface OutboundCommsProvider {
  readonly name: string;
  send(notification: Notification): Promise<boolean>;
  test(): Promise<boolean>;
}

export interface InboundCommsProvider {
  readonly name: string;
  start(callback: InboundCallback): Promise<void>;
  stop(): Promise<void>;
  test(): Promise<boolean>;
}

export interface MemoryProvider {
  readonly name: string;
  store(entry: MemoryEntry): Promise<boolean>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  getRecent(limit?: number): Promise<MemoryEntry[]>;
  initialize(): Promise<void>;
}

export interface ModelProvider {
  readonly name: string;
  generate(prompt: string, system?: string, model?: string): Promise<ModelResponse>;
  isAvailable(): Promise<boolean>;
}

export interface FileSyncProvider {
  readonly name: string;
  sync(filePath: string): Promise<string | null>;
  test(): Promise<boolean>;
}

// =============================================================================
// CONFIG TYPES
// =============================================================================

export interface ProviderEntry {
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface WorkspaceConfig {
  projectsDir: string;      // where projects live (default: <workspace>/projects)
  templatesDir: string;     // additional template search path
  globalConfigDir: string;  // override global config location (default: ~/.tasksmith)
}

export interface ForgeConfig {
  system: { name: string; version: string; logLevel: string };
  workspace: WorkspaceConfig;
  communication: {
    outbound: ProviderEntry[];
    inbound: ProviderEntry[];
  };
  memory: {
    hot: { provider: string; config: Record<string, unknown> };
    warm: ProviderEntry[];
    cold: { provider: string; config: Record<string, unknown> };
  };
  models: {
    routing: Record<string, { provider: string; model: string; fallback?: { provider: string; model: string } }>;
    providers: ProviderEntry[];
  };
  fileSharing: ProviderEntry[];
  scheduling: {
    provider: string;
    tasks: Array<{ name: string; schedule: string; template: string; params: Record<string, unknown>; enabled: boolean }>;
  };
  taskDefaults: {
    maxIterations: number;
    timeoutMinutes: number;
    notifyOnComplete: boolean;
    notifyOnFailure: boolean;
    model: string;
    priority: string;
  };
}
