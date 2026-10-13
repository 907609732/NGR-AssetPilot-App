export interface Period {
  start: string;
  end: string;
}
export type CaptureScope = { kind: "range"; period: Period } | { kind: "all" };
export interface RawItem {
  key: string;
  id: string;
  shortId: string;
  workspaceId: string;
  workspaceName: string;
  type: string;
  typeLabel: string;
  title: string;
  status: string;
  owner: string;
  processedAt: string;
  url: string;
}
export interface Capture {
  /** Missing on v1.0 snapshots, which captured all history. */
  scope?: CaptureScope;
  scanned?: number;
  pageTotal?: number | null;
  id: string;
  capturedAt: string;
  account: string;
  total: number | null;
  loaded: number;
  complete: boolean;
  issues: string[];
  items: RawItem[];
  groups: {
    name: string;
    expected: number;
    loaded: number;
    skipped?: boolean;
    bounded?: boolean;
  }[];
}
export interface Override {
  title?: string;
  category?: string;
  level?: string;
  included?: boolean;
  dates?: string[];
  lockedUnits?: Record<string, number>;
  mergeId?: string | null;
  sourceSignature?: string;
  acknowledgedSignature?: string;
}
export interface Rule {
  keyword: string;
  category: string;
}
export interface Settings {
  person: string;
  supplier: string;
  unit: string;
  testOrder: string;
  content: string;
  width: number;
  height: number;
  method: string;
  productionLevel: string;
  rules: Rule[];
}
export interface LocalState {
  capture: Capture | null;
  overrides: Record<string, Override>;
  budgets: Record<string, number>;
  settings: Settings;
  history: {
    id: string;
    capturedAt: string;
    loaded: number;
    complete: boolean;
    scope?: CaptureScope;
  }[];
  exports: { at: string; path: string; kind: string; draft: boolean }[];
}
export interface PreparedItem extends RawItem {
  cleanTitle: string;
  category: string;
  level: string;
  dates: string[];
  included: boolean;
  allocations: Record<string, number>;
  mergeId?: string | null;
  changed: boolean;
  issues: string[];
}
export interface ReportEntry {
  key: string;
  sourceKeys: string[];
  title: string;
  category: string;
  level: string;
  dates: string[];
  units: number;
  allocations: Record<string, number>;
}
export interface Report {
  items: PreparedItem[];
  entries: ReportEntry[];
  issues: string[];
  includedCount: number;
  dayCount: number;
  totalUnits: number;
  days: { date: string; budget: number; allocated: number }[];
}
export interface Progress {
  phase: string;
  message: string;
  loaded?: number;
  total?: number | null;
}
export type ExportKind = "xlsx" | "txt" | "md" | "csv";
export interface Bridge {
  load(): Promise<LocalState>;
  login(): Promise<void>;
  collect(scope: CaptureScope): Promise<LocalState>;
  cancel(): Promise<void>;
  save(input: {
    overrides?: Record<string, Override>;
    budgets?: Record<string, number>;
    settings?: Settings;
  }): Promise<LocalState>;
  restoreSnapshot(id: string): Promise<LocalState>;
  clearAllData(): Promise<LocalState | null>;
  export(input: {
    kind: ExportKind;
    period: Period;
    draft: boolean;
  }): Promise<string | null>;
  copy(input: { period: Period; html: boolean; draft: boolean }): Promise<void>;
  openPath(path: string): Promise<void>;
  openItem(url: string): Promise<void>;
  onProgress(listener: (progress: Progress) => void): () => void;
}
