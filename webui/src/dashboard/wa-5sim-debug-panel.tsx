import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Play, RefreshCcw, Search, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  banFiveSimOrder,
  buyFiveSimWhatsAppOrder,
  cancelFiveSimOrder,
  checkFiveSimOrder,
  finishFiveSimOrder,
  getFiveSimStatus,
  getFiveSimWhatsAppInventory,
  type FiveSimInventoryItem,
  type FiveSimOrder,
  type FiveSimStatus,
  type WaPhoneInput,
} from './wa-api';
import {
  compareFiveSimInventoryQuality,
  errorMessage,
  filterFiveSimCountries,
  fiveSimCountryLabel,
  fiveSimFailureAction,
  fiveSimFailureReason,
  fiveSimFailureReasonLabel,
  fiveSimProductLabel,
  localizedFiveSimErrorMessage,
  type FiveSimFailureAction,
} from './wa-5sim-debug-model';

const SMS_POLL_INTERVAL_MS = 5000;
const SMS_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const FAILURE_RETRY_DELAY_MS = 10000;
const MAX_LOG_LINES = 80;

type RunStats = {
  target: number;
  completed: number;
  success: number;
  failed: number;
};

type AttemptResult = 'success' | 'failed';

type RegistrationResult = {
  accountID: string;
};

type Props = {
  disabled?: boolean;
  waBusy?: boolean;
  onRunRegistration: (phone: WaPhoneInput) => Promise<RegistrationResult>;
  onSubmitOTP: (accountID: string, code: string) => Promise<void>;
};

export function WaFiveSimDebugPanel({ disabled, waBusy, onRunRegistration, onSubmitOTP }: Props) {
  const [status, setStatus] = useState<FiveSimStatus | null>(null);
  const [inventory, setInventory] = useState<FiveSimInventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [country, setCountry] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [operator, setOperator] = useState('');
  const product = 'whatsapp';
  const [maxPrice, setMaxPrice] = useState('');
  const [successTarget, setSuccessTarget] = useState('1');
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState('空闲');
  const [activeOrderID, setActiveOrderID] = useState<number | null>(null);
  const [stats, setStats] = useState<RunStats>({ target: 0, completed: 0, success: 0, failed: 0 });
  const [failureReasons, setFailureReasons] = useState<Record<string, number>>({});
  const [latestFailure, setLatestFailure] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const cancelRequested = useRef(false);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [nextStatus, nextInventory] = await Promise.all([getFiveSimStatus(), getFiveSimWhatsAppInventory()]);
      const items = nextInventory.items || [];
      setStatus(nextStatus);
      setInventory(items);
      const recommended = [...items].sort(compareFiveSimInventoryQuality)[0];
      if (recommended) {
        setCountry((value) => value || recommended.country);
        setOperator((value) => value || recommended.operator);
        setMaxPrice((value) => value || String(recommended.cost));
      }
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  const canStart = configured && Boolean(country && operator) && !disabled && !waBusy && !running;

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  useEffect(() => {
    if (!country && countries[0]) setCountry(countries[0]);
  }, [countries, country]);

  useEffect(() => {
    if (!operators.length) {
      setOperator('');
      return;
    }
    if (!operators.some((item) => item.operator === operator)) {
      setOperator(operators[0].operator);
      setMaxPrice(String(operators[0].cost));
    }
  }, [operator, operators]);

  async function runDebug() {
    if (!canStart) return;
    cancelRequested.current = false;
    setRunning(true);
    setRunLabel('准备开始');
    setActiveOrderID(null);
    setStats({ target: targetSuccess, completed: 0, success: 0, failed: 0 });
    setFailureReasons({});
    setLatestFailure('');
    setLogs([formatRunLog(`启动 5sim 调试，成功注册目标 ${targetSuccess}`)]);
    let successCount = 0;
    let attempt = 1;
    try {
      while (successCount < targetSuccess && !cancelRequested.current) {
        const result = await runAttempt(attempt);
        if (result === 'success') successCount += 1;
        attempt += 1;
        if (result === 'failed' && successCount < targetSuccess && !cancelRequested.current) {
          updateRunLabel('等待 10 秒后开始下一轮注册');
          await sleepWithStop(FAILURE_RETRY_DELAY_MS, () => cancelRequested.current);
        }
      }
    } finally {
      updateRunLabel(cancelRequested.current ? '已停止' : '成功注册目标已达成');
      setActiveOrderID(null);
      setRunning(false);
    }
  }

  async function runAttempt(attempt: number): Promise<AttemptResult> {
    let order: FiveSimOrder | null = null;
    let finished = false;
    try {
      updateRunLabel(`第 ${attempt} 轮：购买 5sim 号码`);
      order = await buyFiveSimWhatsAppOrder({ country, operator, max_price: Number(maxPrice) || 0 });
      setActiveOrderID(order.id);
      appendLog(`第 ${attempt} 轮：订单 ${order.id} 已创建`);
      if (!order.phone_target) throw new Error('5SIM_PHONE_UNUSABLE');

      updateRunLabel(`第 ${attempt} 轮：请求 WA 验证码`);
      const registration = await onRunRegistration(order.phone_target);

      updateRunLabel(`第 ${attempt} 轮：等待 5sim 短信`);
      const checked = await waitForSMS(order.id, attempt);
      if (!checked.sms_code) throw new Error('OTP_TIMEOUT');

      updateRunLabel(`第 ${attempt} 轮：提交 OTP`);
      await onSubmitOTP(registration.accountID, checked.sms_code);

      updateRunLabel(`第 ${attempt} 轮：完成 5sim 订单`);
      await finishFiveSimOrder(order.id);
      finished = true;
      setStats((value) => ({ ...value, completed: value.completed + 1, success: value.success + 1 }));
      appendLog(`第 ${attempt} 轮：注册成功`);
      return 'success';
    } catch (error) {
      const message = errorMessage(error);
      const reason = fiveSimFailureReason(message);
      const localizedMessage = localizedFiveSimErrorMessage(error);
      recordFailure(reason, localizedMessage);
      appendLog(`第 ${attempt} 轮失败：${fiveSimFailureReasonLabel(reason)} - ${localizedMessage}`);
      if (order && !finished) {
        await closeOrderAfterFailure(order.id, fiveSimFailureAction(message));
      }
      setStats((value) => ({ ...value, completed: value.completed + 1, failed: value.failed + 1 }));
      return 'failed';
    } finally {
      setActiveOrderID(null);
    }
  }

  async function waitForSMS(orderID: number, attempt: number) {
    const startedAt = Date.now();
    const deadline = Date.now() + SMS_POLL_TIMEOUT_MS;
    let pollCount = 1;
    while (Date.now() < deadline) {
      if (cancelRequested.current) throw new Error('RUN_STOPPED');
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      appendLog(`第 ${attempt} 轮：等待短信 ${elapsedSeconds}s，剩余 ${remainingSeconds}s，第 ${pollCount} 次查询`);
      const order = await checkFiveSimOrder(orderID);
      if (order.sms_code) {
        appendLog(`第 ${attempt} 轮：已收到短信，准备提交 OTP`);
        return order;
      }
      appendLog(`第 ${attempt} 轮：暂未收到短信，订单状态 ${order.status || '-'}，短信数 ${order.sms_count}`);
      pollCount += 1;
      await sleepWithStop(Math.min(SMS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), () => cancelRequested.current);
    }
    appendLog(`第 ${attempt} 轮：等待短信超过 5 分钟，按失败处理并取消订单`);
    throw new Error('OTP_TIMEOUT');
  }

  async function closeOrderAfterFailure(orderID: number, action: FiveSimFailureAction) {
    try {
      if (action === 'ban') {
        updateRunLabel(`上报 5sim 坏号 ${orderID}`);
        await banFiveSimOrder(orderID);
        appendLog(`5sim 订单 ${orderID} 已上报坏号`);
        return;
      }
      updateRunLabel(`取消 5sim 订单 ${orderID}`);
      await cancelFiveSimOrder(orderID);
      appendLog(`5sim 订单 ${orderID} 已取消`);
    } catch (error) {
      recordFailure(action === 'ban' ? 'BAN_FAILED' : 'CANCEL_FAILED', localizedFiveSimErrorMessage(error));
    }
  }

  function recordFailure(reason: string, message: string) {
    setFailureReasons((value) => ({ ...value, [reason]: (value[reason] || 0) + 1 }));
    setLatestFailure(message);
  }

  function updateRunLabel(message: string) {
    setRunLabel(message);
    appendLog(message);
  }

  function appendLog(message: string) {
    setLogs((value) => [...value, formatRunLog(message)].slice(-MAX_LOG_LINES));
  }

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-1">
          <div className="text-sm font-medium">5sim 调试</div>
          <FieldDescription className="text-xs">选择 WhatsApp 国家、渠道、价格和成功目标后，串行购买号码、轮询短信并自动提交 OTP。</FieldDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={configured ? 'default' : 'secondary'}>{configured ? '已配置' : '未配置 API key'}</Badge>
          <Button type="button" size="icon" variant="outline" title="刷新 5sim 库存" aria-label="刷新 5sim 库存" disabled={loading || running} onClick={() => void refresh()}>
            {loading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCcw size={14} />}
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
            <Select value={country} disabled={running || loading || countries.length === 0} onOpenChange={(open) => { if (!open) setCountrySearch(''); }} onValueChange={setCountry}>
              <SelectTrigger className="w-full min-w-0">
                <SelectValue placeholder="选择国家">{country ? fiveSimCountryLabel(country) : '选择国家'}</SelectValue>
              </SelectTrigger>
              <SelectContent className="min-w-64">
                <div className="sticky top-0 z-10 bg-popover p-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 pl-7 text-xs"
                      value={countrySearch}
                      placeholder="搜索中文或 5sim 国家值"
                      onChange={(event) => setCountrySearch(event.target.value)}
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                  </div>
                </div>
                {filteredCountries.length ? filteredCountries.map((item) => <SelectItem key={item} value={item}>{fiveSimCountryLabel(item)}</SelectItem>) : <div className="px-3 py-2 text-xs text-muted-foreground">没有匹配国家</div>}
              </SelectContent>
            </Select>
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>渠道</FieldLabel>
            <Select value={operator} disabled={running || loading || operators.length === 0} onValueChange={setOperator}>
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
            <Input inputMode="decimal" value={maxPrice} disabled={running} onChange={(event) => setMaxPrice(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>成功注册目标</FieldLabel>
            <Input inputMode="numeric" min={1} max={100} value={successTarget} disabled={running} onChange={(event) => setSuccessTarget(event.target.value)} />
          </Field>
          <div className="flex gap-2 sm:justify-end">
            {running ? (
              <Button type="button" variant="outline" size="sm" onClick={() => { cancelRequested.current = true; appendLog('收到停止请求，当前订单会先关闭'); }}>
                <Square size={14} />
                停止
              </Button>
            ) : null}
            <Button type="button" size="sm" className="min-w-20" disabled={!canStart} onClick={() => void runDebug()}>
              <Play size={14} />
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
        <div className="grid gap-1 rounded-md border border-border bg-background/70 p-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">运行日志</span>
            <span className="text-muted-foreground">等待短信最多 5 分钟</span>
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

function clampInteger(value: number, min: number, maxValue: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(maxValue, Math.max(min, Math.floor(value)));
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function sleepWithStop(ms: number, stopped: () => boolean) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !stopped()) {
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}

function formatRunLog(message: string) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return `${time} ${message}`;
}
