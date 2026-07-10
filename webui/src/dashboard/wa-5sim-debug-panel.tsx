import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ChevronDown, LoaderCircle, Play, RefreshCcw, Search, Square, SquareStack } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getFiveSimRegistrationTasks,
  getFiveSimStatus,
  getFiveSimWhatsAppInventory,
  startFiveSimRegistrationTask,
  stopAllFiveSimRegistrationTasks,
  stopFiveSimRegistrationTask,
  type FiveSimRegistrationTask,
} from './wa-api';
import {
  compareFiveSimInventoryQuality,
  errorMessage,
  filterFiveSimCountries,
  fiveSimCountryLabel,
  fiveSimFailureReasonLabel,
  fiveSimProductLabel,
} from './wa-5sim-debug-model';
import { fiveSimDebugSession, type FiveSimDebugSessionState } from './wa-5sim-debug-session';

type Props = {
  disabled?: boolean;
  waBusy?: boolean;
};

export function WaFiveSimDebugPanel({ disabled, waBusy }: Props) {
  const session = useFiveSimDebugSession();
  const {
    status,
    inventory,
    tasks,
    loading,
    tasksLoading,
    actionPending,
    loadError,
    country,
    countrySearch,
    operator,
    maxPrice,
    successTarget,
    running,
    stopRequested,
    activeTaskID,
    activeTaskCount,
    runLabel,
    activeOrderID,
    stats,
    failureReasons,
    latestFailure,
    logs,
  } = session;
  const product = 'whatsapp';
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  const refreshTasks = useCallback(async () => {
    fiveSimDebugSession.setState({ tasksLoading: true });
    try {
      const response = await getFiveSimRegistrationTasks();
      fiveSimDebugSession.setState({ tasks: response.tasks || [], loadError: '' });
    } catch (error) {
      fiveSimDebugSession.setState({ loadError: errorMessage(error) });
    } finally {
      fiveSimDebugSession.setState({ tasksLoading: false });
    }
  }, []);

  const refresh = useCallback(async () => {
    fiveSimDebugSession.setState({ loading: true, loadError: '' });
    try {
      const [nextStatus, nextInventory, nextTasks] = await Promise.all([getFiveSimStatus(), getFiveSimWhatsAppInventory(), getFiveSimRegistrationTasks()]);
      const items = nextInventory.items || [];
      fiveSimDebugSession.setState((value) => {
        const recommended = [...items].sort(compareFiveSimInventoryQuality)[0];
        return {
          status: nextStatus,
          inventory: items,
          tasks: nextTasks.tasks || [],
          country: value.country || recommended?.country || '',
          operator: value.operator || recommended?.operator || '',
          maxPrice: value.maxPrice || (recommended ? String(recommended.cost) : ''),
        };
      });
    } catch (error) {
      fiveSimDebugSession.setState({ loadError: errorMessage(error) });
    } finally {
      fiveSimDebugSession.setState({ loading: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!running && tasks.length === 0) return undefined;
    const timer = window.setInterval(() => {
      void refreshTasks();
    }, running ? 3000 : 10000);
    return () => window.clearInterval(timer);
  }, [refreshTasks, running, tasks.length]);

  const countries = useMemo(() => {
    return [...new Set(inventory.map((item) => item.country))]
      .sort((a, b) => fiveSimCountryLabel(a).localeCompare(fiveSimCountryLabel(b), 'zh-Hans-CN'));
  }, [inventory]);

  const filteredCountries = useMemo(() => filterFiveSimCountries(countries, countrySearch), [countries, countrySearch]);

  const operators = useMemo(() => {
    return inventory.filter((item) => item.country === country).sort(compareFiveSimInventoryQuality);
  }, [country, inventory]);

  const selectedInventory = operators.find((item) => item.operator === operator) || null;
  const configured = status?.configured === true;
  const targetSuccess = clampInteger(Number(successTarget), 1, 100);
  const canStart = configured && Boolean(country && operator) && !disabled && !waBusy && !running && !actionPending;

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  useEffect(() => {
    if (!country && countries[0]) fiveSimDebugSession.setState({ country: countries[0] });
  }, [countries, country]);

  useEffect(() => {
    if (!operators.length) {
      fiveSimDebugSession.setState({ operator: '' });
      return;
    }
    if (!operators.some((item) => item.operator === operator)) {
      fiveSimDebugSession.setState({ operator: operators[0].operator, maxPrice: String(operators[0].cost) });
    }
  }, [operator, operators]);

  async function startTask() {
    if (!canStart) return;
    fiveSimDebugSession.setState({ actionPending: true, loadError: '' });
    try {
      const response = await startFiveSimRegistrationTask({
        country,
        operator,
        max_price: Number(maxPrice) || 0,
        success_target: targetSuccess,
      });
      fiveSimDebugSession.setState((value) => ({ tasks: upsertTask(value.tasks, response.task) }));
      await refreshTasks();
    } catch (error) {
      fiveSimDebugSession.setState({ loadError: errorMessage(error) });
    } finally {
      fiveSimDebugSession.setState({ actionPending: false });
    }
  }

  async function stopActiveTask() {
    if (!activeTaskID) return;
    fiveSimDebugSession.setState({ actionPending: true, loadError: '' });
    try {
      const response = await stopFiveSimRegistrationTask(activeTaskID);
      fiveSimDebugSession.setState((value) => ({ tasks: upsertTask(value.tasks, response.task) }));
      await refreshTasks();
    } catch (error) {
      fiveSimDebugSession.setState({ loadError: errorMessage(error) });
    } finally {
      fiveSimDebugSession.setState({ actionPending: false });
    }
  }

  async function stopAllTasks() {
    fiveSimDebugSession.setState({ actionPending: true, loadError: '' });
    try {
      const response = await stopAllFiveSimRegistrationTasks();
      fiveSimDebugSession.setState({ tasks: response.tasks || [] });
      await refreshTasks();
    } catch (error) {
      fiveSimDebugSession.setState({ loadError: errorMessage(error) });
    } finally {
      fiveSimDebugSession.setState({ actionPending: false });
    }
  }

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-1">
          <div className="text-sm font-medium">5sim 调试</div>
          <FieldDescription className="text-xs">后端任务会购买号码、轮询短信并自动提交 OTP；刷新页面后仍可从任务列表恢复状态。</FieldDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={configured ? 'default' : 'secondary'}>{configured ? '已配置' : '未配置 API key'}</Badge>
          <Button type="button" size="icon" variant="outline" title="刷新 5sim 库存和任务" aria-label="刷新 5sim 库存和任务" disabled={loading || actionPending} onClick={() => void refresh()}>
            {loading || tasksLoading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCcw size={14} />}
          </Button>
        </div>
      </div>
      <FieldGroup className="gap-3">
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>服务</FieldLabel>
            <Select value={product} disabled>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择服务" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="whatsapp">{fiveSimProductLabel('whatsapp')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>国家</FieldLabel>
            <CountrySearchSelect
              value={country}
              countries={countries}
              filteredCountries={filteredCountries}
              search={countrySearch}
              disabled={running || loading || countries.length === 0}
              onSearchChange={(nextValue) => fiveSimDebugSession.setState({ countrySearch: nextValue })}
              onValueChange={(nextValue) => fiveSimDebugSession.setState({ country: nextValue })}
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>渠道</FieldLabel>
            <Select value={operator} disabled={running || loading || operators.length === 0} onValueChange={(nextValue) => fiveSimDebugSession.setState({ operator: nextValue })}>
              <SelectTrigger className="w-full min-w-0">
                <SelectValue placeholder="选择渠道">{operator || '选择渠道'}</SelectValue>
              </SelectTrigger>
              <SelectContent className="min-w-80">
                {operators.map((item) => (
                  <SelectItem key={item.operator} value={item.operator}>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">{item.operator}</span>
                      <span className="text-xs text-muted-foreground">价格 {item.cost} / 库存 {item.count} / rate {item.rate ?? 0}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <Field>
            <FieldLabel>最高价格</FieldLabel>
            <Input inputMode="decimal" value={maxPrice} disabled={running} onChange={(event) => fiveSimDebugSession.setState({ maxPrice: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel>成功注册目标</FieldLabel>
            <Input inputMode="numeric" min={1} max={100} value={successTarget} disabled={running} onChange={(event) => fiveSimDebugSession.setState({ successTarget: event.target.value })} />
          </Field>
          <div className="flex gap-2 sm:justify-end">
            {running ? (
              <Button type="button" variant="outline" size="sm" disabled={stopRequested || actionPending} onClick={() => void stopActiveTask()}>
                <Square size={14} />
                {stopRequested ? '停止中' : '停止当前'}
              </Button>
            ) : null}
            {activeTaskCount > 1 ? (
              <Button type="button" variant="outline" size="sm" disabled={actionPending} onClick={() => void stopAllTasks()}>
                <SquareStack size={14} />
                全部停止
              </Button>
            ) : null}
            <Button type="button" size="sm" className="min-w-20" disabled={!canStart} onClick={() => void startTask()}>
              {actionPending ? <LoaderCircle className="animate-spin" size={14} /> : <Play size={14} />}
              开始
            </Button>
          </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">目标 {stats.target || targetSuccess}</Badge>
            <Badge variant="outline">完成 {stats.completed}</Badge>
            <Badge variant="default">成功 {stats.success}</Badge>
            <Badge variant={stats.failed > 0 ? 'destructive' : 'outline'}>失败 {stats.failed}</Badge>
            <Badge variant={activeTaskCount > 0 ? 'default' : 'outline'}>运行任务 {activeTaskCount}</Badge>
            {activeTaskID ? <Badge variant="secondary">任务 {activeTaskID}</Badge> : null}
            {selectedInventory ? <Badge variant="secondary">库存 {selectedInventory.count} / 价格 {selectedInventory.cost} / rate {selectedInventory.rate ?? 0}</Badge> : null}
            {activeOrderID ? <Badge variant="secondary">订单 {activeOrderID}</Badge> : null}
          </div>
        </div>
        <div className="min-h-5 break-words text-xs text-muted-foreground">{loadError || runLabel}</div>
        {Object.keys(failureReasons).length ? (
          <div className="grid gap-1 text-xs">
            <div className="font-medium text-destructive">失败原因</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(failureReasons).map(([reason, count]) => <Badge key={reason} variant="outline">{fiveSimFailureReasonLabel(reason)} x{count}</Badge>)}
            </div>
            {latestFailure ? <div className="break-words text-muted-foreground">最近失败：{latestFailure}</div> : null}
          </div>
        ) : null}
        <TaskHistory tasks={tasks} />
        <div className="grid gap-1 rounded-md border border-border bg-background/70 p-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">运行日志</span>
            <span className="text-muted-foreground">后台任务轮询恢复</span>
          </div>
          <div className="h-32 overflow-y-auto rounded-sm bg-muted/40 px-2 py-1 font-mono text-[11px] leading-5 text-muted-foreground">
            {logs.length ? logs.map((line, index) => <div key={`${index}-${line}`} className="break-words">{line}</div>) : <div>暂无日志</div>}
            <div ref={logsEndRef} />
          </div>
        </div>
      </FieldGroup>
    </div>
  );
}

function TaskHistory({ tasks }: { tasks: FiveSimRegistrationTask[] }) {
  if (!tasks.length) return null;
  return (
    <div className="grid gap-1 rounded-md border border-border bg-background/60 p-2 text-xs">
      <div className="font-medium">后台任务</div>
      <div className="grid max-h-28 gap-1 overflow-y-auto">
        {tasks.slice(0, 8).map((task) => (
          <div key={task.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-0.5">
            <span className="truncate">{task.id} · {task.country}/{task.operator}</span>
            <span className="text-muted-foreground">{task.status} · 成功 {task.stats?.success ?? 0}/{task.success_target}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CountrySearchSelect({
  value,
  countries,
  filteredCountries,
  search,
  disabled,
  onSearchChange,
  onValueChange,
}: {
  value: string;
  countries: string[];
  filteredCountries: string[];
  search: string;
  disabled?: boolean;
  onSearchChange: (value: string) => void;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectedLabel = value ? fiveSimCountryLabel(value) : '';

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
      onSearchChange('');
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [onSearchChange, open]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  function selectCountry(nextValue: string) {
    onValueChange(nextValue);
    onSearchChange('');
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="outline"
        className="h-8 w-full justify-between gap-2 px-2.5 text-left font-normal"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={selectedLabel ? 'truncate' : 'truncate text-muted-foreground'}>{selectedLabel || '选择国家'}</span>
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
      </Button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-full min-w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                className="h-8 pl-7 text-xs"
                value={search}
                placeholder="搜索中文或 5sim 国家值"
                autoComplete="off"
                onChange={(event) => onSearchChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setOpen(false);
                    onSearchChange('');
                  }
                }}
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto p-1" role="listbox">
            {filteredCountries.length ? filteredCountries.map((item) => {
              const selected = item === value;
              return (
                <button
                  key={item}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => selectCountry(item)}
                >
                  <span className="truncate">{fiveSimCountryLabel(item)}</span>
                  {selected ? <Check size={14} className="shrink-0" /> : null}
                </button>
              );
            }) : <div className="px-2 py-2 text-xs text-muted-foreground">{countries.length ? '没有匹配国家' : '暂无国家库存'}</div>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function upsertTask(tasks: FiveSimRegistrationTask[], task: FiveSimRegistrationTask) {
  const next = tasks.filter((item) => item.id !== task.id);
  next.unshift(task);
  return next;
}

function clampInteger(value: number, min: number, maxValue: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(maxValue, Math.max(min, Math.floor(value)));
}

function useFiveSimDebugSession(): FiveSimDebugSessionState {
  return useSyncExternalStore(
    fiveSimDebugSession.subscribe,
    fiveSimDebugSession.getSnapshot,
    fiveSimDebugSession.getSnapshot,
  );
}
