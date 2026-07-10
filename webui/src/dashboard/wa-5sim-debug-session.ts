import type { FiveSimInventoryItem, FiveSimRegistrationTask, FiveSimStatus } from './wa-api';

export type FiveSimRunStats = {
  target: number;
  completed: number;
  success: number;
  failed: number;
};

export type FiveSimDebugSessionState = {
  status: FiveSimStatus | null;
  inventory: FiveSimInventoryItem[];
  tasks: FiveSimRegistrationTask[];
  loading: boolean;
  tasksLoading: boolean;
  actionPending: boolean;
  loadError: string;
  country: string;
  countrySearch: string;
  operator: string;
  maxPrice: string;
  successTarget: string;
  running: boolean;
  stopRequested: boolean;
  activeTaskID: string;
  activeTaskCount: number;
  runLabel: string;
  activeOrderID: number | null;
  stats: FiveSimRunStats;
  failureReasons: Record<string, number>;
  latestFailure: string;
  logs: string[];
};

type Listener = () => void;
type StatePatch = Partial<FiveSimDebugSessionState>;
type StateUpdater = StatePatch | ((state: FiveSimDebugSessionState) => StatePatch);

const initialStats: FiveSimRunStats = { target: 0, completed: 0, success: 0, failed: 0 };

const initialState: FiveSimDebugSessionState = {
  status: null,
  inventory: [],
  tasks: [],
  loading: false,
  tasksLoading: false,
  actionPending: false,
  loadError: '',
  country: '',
  countrySearch: '',
  operator: '',
  maxPrice: '',
  successTarget: '1',
  running: false,
  stopRequested: false,
  activeTaskID: '',
  activeTaskCount: 0,
  runLabel: '空闲',
  activeOrderID: null,
  stats: initialStats,
  failureReasons: {},
  latestFailure: '',
  logs: [],
};

export function createFiveSimDebugSession(initial?: Partial<FiveSimDebugSessionState>) {
  let state = deriveRuntimeState({
    ...initialState,
    ...initial,
    inventory: initial?.inventory ? [...initial.inventory] : [],
    tasks: initial?.tasks ? [...initial.tasks] : [],
    stats: initial?.stats ? { ...initial.stats } : { ...initialStats },
    failureReasons: initial?.failureReasons ? { ...initial.failureReasons } : {},
    logs: initial?.logs ? [...initial.logs] : [],
  });
  const listeners = new Set<Listener>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function setState(updater: StateUpdater) {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = deriveRuntimeState({ ...state, ...patch });
    notify();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState,
  };
}

export const fiveSimDebugSession = createFiveSimDebugSession();

export function selectActiveFiveSimTask(tasks: FiveSimRegistrationTask[]) {
  const active = tasks
    .filter((task) => task.status === 'running' || task.status === 'stopping')
    .sort((a, b) => timestamp(b.updated_at || b.created_at) - timestamp(a.updated_at || a.created_at));
  if (active[0]) return active[0];
  return [...tasks].sort((a, b) => timestamp(b.updated_at || b.created_at) - timestamp(a.updated_at || a.created_at))[0] || null;
}

function deriveRuntimeState(state: FiveSimDebugSessionState): FiveSimDebugSessionState {
  const activeTasks = state.tasks.filter((task) => task.status === 'running' || task.status === 'stopping');
  const selected = selectActiveFiveSimTask(state.tasks);
  if (!selected) {
    return {
      ...state,
      running: false,
      stopRequested: false,
      activeTaskID: '',
      activeTaskCount: 0,
      runLabel: state.loadError || '空闲',
      activeOrderID: null,
      stats: { ...initialStats },
      failureReasons: {},
      latestFailure: '',
      logs: [],
    };
  }
  return {
    ...state,
    running: selected.status === 'running' || selected.status === 'stopping',
    stopRequested: selected.status === 'stopping' || selected.stop_requested === true,
    activeTaskID: selected.id,
    activeTaskCount: activeTasks.length,
    runLabel: taskRunLabel(selected),
    activeOrderID: selected.active_order?.id ?? null,
    stats: selected.stats || { ...initialStats, target: selected.success_target || 0 },
    failureReasons: selected.failure_reasons || {},
    latestFailure: selected.last_error || '',
    logs: selected.logs || [],
  };
}

function taskRunLabel(task: FiveSimRegistrationTask) {
  const latestLog = task.logs?.at(-1)?.replace(/^\d{2}:\d{2}:\d{2}\s+/, '') || '';
  if (latestLog) return latestLog;
  switch (task.status) {
    case 'running':
      return `任务 ${task.id} 运行中`;
    case 'stopping':
      return `任务 ${task.id} 停止中`;
    case 'succeeded':
      return `任务 ${task.id} 已完成`;
    case 'stopped':
      return `任务 ${task.id} 已停止`;
    case 'failed':
      return task.last_error || `任务 ${task.id} 失败`;
    default:
      return '空闲';
  }
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
