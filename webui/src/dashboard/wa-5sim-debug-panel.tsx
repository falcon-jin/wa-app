import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Play, RefreshCcw, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
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

const SMS_POLL_INTERVAL_MS = 5000;
const SMS_POLL_TIMEOUT_MS = 180000;

type RunStats = {
  planned: number;
  completed: number;
  success: number;
  failed: number;
};

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
  const [operator, setOperator] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [attempts, setAttempts] = useState('1');
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState('空闲');
  const [activeOrderID, setActiveOrderID] = useState<number | null>(null);
  const [stats, setStats] = useState<RunStats>({ planned: 0, completed: 0, success: 0, failed: 0 });
  const [failureReasons, setFailureReasons] = useState<Record<string, number>>({});
  const [latestFailure, setLatestFailure] = useState('');
  const cancelRequested = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [nextStatus, nextInventory] = await Promise.all([getFiveSimStatus(), getFiveSimWhatsAppInventory()]);
      const items = nextInventory.items || [];
      setStatus(nextStatus);
      setInventory(items);
      const firstAvailable = items.find((item) => item.count > 0) || items[0];
      if (firstAvailable) {
        setCountry((value) => value || firstAvailable.country);
        setOperator((value) => value || firstAvailable.operator);
        setMaxPrice((value) => value || String(firstAvailable.cost));
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
    return [...new Set(inventory.map((item) => item.country))].sort();
  }, [inventory]);

  const operators = useMemo(() => {
    return inventory.filter((item) => item.country === country).sort((a, b) => a.operator.localeCompare(b.operator));
  }, [country, inventory]);

  const selectedInventory = operators.find((item) => item.operator === operator) || null;
  const configured = status?.configured === true;
  const plannedAttempts = clampInteger(Number(attempts), 1, 100);
  const canStart = configured && Boolean(country && operator) && !disabled && !waBusy && !running;

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
    setStats({ planned: plannedAttempts, completed: 0, success: 0, failed: 0 });
    setFailureReasons({});
    setLatestFailure('');
    try {
      for (let attempt = 1; attempt <= plannedAttempts; attempt += 1) {
        if (cancelRequested.current) break;
        await runAttempt(attempt);
      }
    } finally {
      setRunLabel(cancelRequested.current ? '已停止' : '空闲');
      setActiveOrderID(null);
      setRunning(false);
    }
  }

  async function runAttempt(attempt: number) {
    let order: FiveSimOrder | null = null;
    let finished = false;
    try {
      setRunLabel(`第 ${attempt} 次：购买号码`);
      order = await buyFiveSimWhatsAppOrder({ country, operator, max_price: Number(maxPrice) || 0 });
      setActiveOrderID(order.id);
      if (!order.phone_target) throw new Error('5SIM_PHONE_UNUSABLE');

      setRunLabel(`第 ${attempt} 次：请求 WA 验证码`);
      const registration = await onRunRegistration(order.phone_target);

      setRunLabel(`第 ${attempt} 次：等待 5sim 短信`);
      const checked = await waitForSMS(order.id);
      if (!checked.sms_code) throw new Error('OTP_TIMEOUT');

      setRunLabel(`第 ${attempt} 次：提交 OTP`);
      await onSubmitOTP(registration.accountID, checked.sms_code);

      setRunLabel(`第 ${attempt} 次：完成 5sim 订单`);
      await finishFiveSimOrder(order.id);
      finished = true;
      setStats((value) => ({ ...value, completed: value.completed + 1, success: value.success + 1 }));
    } catch (error) {
      const reason = failureReason(error);
      recordFailure(reason, localizedErrorMessage(error));
      if (order && !finished) {
        await cancelOrderAfterFailure(order.id);
      }
      setStats((value) => ({ ...value, completed: value.completed + 1, failed: value.failed + 1 }));
    }
  }

  async function waitForSMS(orderID: number) {
    const deadline = Date.now() + SMS_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (cancelRequested.current) throw new Error('RUN_STOPPED');
      const order = await checkFiveSimOrder(orderID);
      if (order.sms_code) return order;
      await sleep(SMS_POLL_INTERVAL_MS);
    }
    throw new Error('OTP_TIMEOUT');
  }

  async function cancelOrderAfterFailure(orderID: number) {
    try {
      setRunLabel(`取消 5sim 订单 ${orderID}`);
      await cancelFiveSimOrder(orderID);
    } catch (error) {
      recordFailure('CANCEL_FAILED', localizedErrorMessage(error));
    }
  }

  function recordFailure(reason: string, message: string) {
    setFailureReasons((value) => ({ ...value, [reason]: (value[reason] || 0) + 1 }));
    setLatestFailure(message);
  }

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-1">
          <div className="text-sm font-medium">5sim 调试</div>
          <FieldDescription className="text-xs">选择 WhatsApp 国家、渠道、价格和次数后，串行购买号码、轮询短信并自动提交 OTP。</FieldDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={configured ? 'default' : 'secondary'}>{configured ? '已配置' : '未配置 API key'}</Badge>
          <Button type="button" size="icon" variant="outline" title="刷新 5sim 库存" aria-label="刷新 5sim 库存" disabled={loading || running} onClick={() => void refresh()}>
            {loading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCcw size={14} />}
          </Button>
        </div>
      </div>
      <FieldGroup className="gap-3">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px_110px]">
          <Field>
            <FieldLabel>国家</FieldLabel>
            <Select value={country} disabled={running || loading || countries.length === 0} onValueChange={setCountry}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择国家" />
              </SelectTrigger>
              <SelectContent>
                {countries.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>渠道</FieldLabel>
            <Select value={operator} disabled={running || loading || operators.length === 0} onValueChange={setOperator}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择渠道" />
              </SelectTrigger>
              <SelectContent>
                {operators.map((item) => <SelectItem key={item.operator} value={item.operator}>{item.operator} / {item.cost} / {item.count}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>最高价格</FieldLabel>
            <Input inputMode="decimal" value={maxPrice} disabled={running} onChange={(event) => setMaxPrice(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>调试次数</FieldLabel>
            <Input inputMode="numeric" min={1} max={100} value={attempts} disabled={running} onChange={(event) => setAttempts(event.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">计划 {stats.planned}</Badge>
            <Badge variant="outline">完成 {stats.completed}</Badge>
            <Badge variant="default">成功 {stats.success}</Badge>
            <Badge variant={stats.failed > 0 ? 'destructive' : 'outline'}>失败 {stats.failed}</Badge>
            {selectedInventory ? <Badge variant="secondary">库存 {selectedInventory.count} / 价格 {selectedInventory.cost}</Badge> : null}
            {activeOrderID ? <Badge variant="secondary">订单 {activeOrderID}</Badge> : null}
          </div>
          <div className="flex gap-2">
            {running ? (
              <Button type="button" variant="outline" size="sm" onClick={() => { cancelRequested.current = true; }}>
                <Square size={14} />
                停止
              </Button>
            ) : null}
            <Button type="button" size="sm" disabled={!canStart} onClick={() => void runDebug()}>
              <Play size={14} />
              开始
            </Button>
          </div>
        </div>
        <div className="min-h-5 text-xs text-muted-foreground">{loadError || runLabel}</div>
        {Object.keys(failureReasons).length ? (
          <div className="grid gap-1 text-xs">
            <div className="font-medium text-destructive">失败原因</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(failureReasons).map(([reason, count]) => <Badge key={reason} variant="outline">{failureReasonLabel(reason)} x{count}</Badge>)}
            </div>
            {latestFailure ? <div className="break-words text-muted-foreground">最近失败：{latestFailure}</div> : null}
          </div>
        ) : null}
      </FieldGroup>
    </div>
  );
}

function failureReason(error: unknown) {
  const message = errorMessage(error);
  if (message.includes('OTP_TIMEOUT')) return 'OTP_TIMEOUT';
  if (message.includes('RUN_STOPPED')) return 'RUN_STOPPED';
  if (message.includes('5SIM_PHONE_UNUSABLE')) return 'PHONE_UNUSABLE';
  if (message.toLowerCase().includes('price')) return 'PRICE_LIMIT';
  if (message.toLowerCase().includes('inventory')) return 'NO_INVENTORY';
  return 'FAILED';
}

function failureReasonLabel(reason: string) {
  switch (reason) {
    case 'OTP_TIMEOUT':
      return '短信超时';
    case 'RUN_STOPPED':
      return '手动停止';
    case 'PHONE_UNUSABLE':
      return '号码不可用';
    case 'PRICE_LIMIT':
      return '超过价格';
    case 'NO_INVENTORY':
      return '库存不可用';
    case 'CANCEL_FAILED':
      return '取消失败';
    default:
      return '失败';
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function localizedErrorMessage(error: unknown) {
  const message = errorMessage(error);
  if (message.includes('OTP_TIMEOUT')) return '等待 5sim 短信超时';
  if (message.includes('RUN_STOPPED')) return '调试已手动停止';
  if (message.includes('5SIM_PHONE_UNUSABLE')) return '5sim 订单没有返回可用手机号';
  return message
    .replace(/^5sim response error:\s*/i, '5sim 响应错误：')
    .replace(/^5sim request failed:\s*/i, '5sim 请求失败：')
    .replace(/^selected 5sim price\s+/i, '选择的 5sim 价格 ')
    .replace(/\s+exceeds max price\s+/i, ' 超过最高价格 ');
}

function clampInteger(value: number, min: number, maxValue: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(maxValue, Math.max(min, Math.floor(value)));
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
