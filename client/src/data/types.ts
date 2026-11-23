// Shapes sent by server.mjs. The reference is server/SNAPSHOT.md.

export type Phase = 'blocked' | 'working' | 'idle' | 'shell';
export type RepoKind = 'web' | 'mobile' | 'docs' | 'data' | 'other';
export type ToolCategory = 'edit' | 'command' | 'search' | 'web' | 'read' | 'other';
export type PlotRef = number | 'hangout' | null;

export interface ToolCall {
  name: string | null;
  detail?: string | null;
  command?: string | null;
}

export interface QuestionOption {
  label: string;
  description?: string | null;
}

export interface Question {
  header: string | null;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export type Blocked =
  | { kind: 'permission'; requestId: string | null; since: string | null; deadline?: string | null; tool: ToolCall }
  | { kind: 'question'; requestId: string | null; since: string | null; deadline?: string | null; questions: Question[] }
  | { kind: 'plan'; requestId: string | null; since: string | null; deadline?: string | null; plan: string | null }
  | { kind: 'terminal'; requestId: null; since: string | null; label: string | null; tool: ToolCall | null };

export interface Item {
  surfaceId: string;
  workspaceId: string;
  workspaceRef: string | null;
  order: number;
  title: string;
  subtitle: string | null;
  here: boolean;
  cwd: string | null;
  project: string | null;
  repo: { key: string; name: string; kind: RepoKind } | null;
  branch: string | null;
  ports: number[];
  agent: { kind: string; sessionId: string; state: string } | null;
  phase: Phase;
  blocked: Blocked | null;
  statusLabel: string | null;
  model: string | null;
  mode: string | null;
  contextTokens: number | null;
  lastPrompt: string | null;
  lastPromptAt: string | null;
  reply: { text: string; at: string } | null;
  recap: { text: string; at: string } | null;
  question: string | null;
  now: ToolCall | null;
  turnStartedAt: string | null;
  lastActivityAt: string | null;
  unread: number;
  activity: number[] | null;
  /** Helpers (subagents, workflow agents) this session ran in the last 90 s. They're never people of their own. */
  crew?: number;
  plot: PlotRef;
  spot: number | null;
  archived: boolean;
}

export interface WorldPlot {
  /** 'overflow': all plots are taken and it waits for one; its people sit at the beach bar. */
  plot: number | 'overflow';
  name: string;
  kind: RepoKind;
  firstSeen: string;
  lastSeen: string | null;
  active: boolean;
  agents: number;
}

export interface WorldState {
  plotCount: number;
  spotsPerPlot: number;
  plots: Record<string, WorldPlot>;
  free: number[];
  archived: { sessionId: string; at: string }[];
}

export interface Snapshot {
  generatedAt: string;
  source: 'cmux' | 'demo';
  demo?: boolean;
  cmux: { ok: boolean; eventsLive?: boolean; error?: string };
  /** cmux held back part of its list: it holds `total` items and Prompt Beach read the first `read`. */
  limited?: { total: number | null; read: number } | null;
  items: Item[];
  pulse: { start: string; binMs: number; bins: number[] };
  world: WorldState;
}

export interface Tick {
  surfaceId: string;
  hook: string;
  tool?: { name: string; category: ToolCategory };
}

export interface Conversation {
  surfaceId: string;
  sessionId: string;
  available: boolean;
  messages: { role: 'user' | 'assistant'; text: string; at: string }[];
  truncated: boolean;
}

export type Action =
  | { action: 'jump'; workspaceId: string; surfaceId: string }
  | { action: 'reply'; workspaceId: string; surfaceId: string; text: string }
  | { action: 'permission'; requestId: string; mode: 'once' | 'always' | 'deny' }
  | { action: 'plan'; requestId: string; mode: 'manual' | 'autoAccept' | 'deny' }
  | { action: 'question'; requestId: string; selections: string[] }
  | { action: 'markRead'; workspaceId: string }
  | { action: 'archive'; sessionId: string }
  | { action: 'unarchive'; sessionId: string }
  | { action: 'movePlot'; repoKey: string; plot: number };
