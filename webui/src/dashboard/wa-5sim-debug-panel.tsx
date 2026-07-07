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
  const [runLabel, setRunLabel] = useState('idle');
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
    setRunLabel('starting');
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
      setRunLabel(cancelRequested.current ? 'stopped' : 'idle');
      setActiveOrderID(null);
      setRunning(false);
    }
  }

  async function runAttempt(attempt: number) {
    let order: FiveSimOrder | null = null;
    let finished = false;
    try {
      setRunLabel(`attempt ${attempt}: buying number`);
      order = await buyFiveSimWhatsAppOrder({ country, operator, max_price: Number(maxPrice) || 0 });
      setActiveOrderID(order.id);
      if (!order.phone_target) throw new Error('5sim order did not return a usable phone number');

      setRunLabel(`attempt ${attempt}: requesting WA OTP`);
      const registration = await onRunRegistration(order.phone_target);

      setRunLabel(`attempt ${attempt}: waiting for SMS`);
      const checked = await waitForSMS(order.id);
      if (!checked.sms_code) throw new Error('OTP_TIMEOUT');

      setRunLabel(`attempt ${attempt}: submitting OTP`);
      await onSubmitOTP(registration.accountID, checked.sms_code);

      setRunLabel(`attempt ${attempt}: finishing 5sim order`);
      await finishFiveSimOrder(order.id);
      finished = true;
      setStats((value) => ({ ...value, completed: value.completed + 1, success: value.success + 1 }));
    } catch (error) {
      const reason = failureReason(error);
      recordFailure(reason, errorMessage(error));
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
      setRunLabel(`canceling 5sim order ${orderID}`);
      await cancelFiveSimOrder(orderID);
    } catch (error) {
      recordFailure('CANCEL_FAILED', errorMessage(error));
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
          <div className="text-sm font-medium">5sim debug</div>
          <FieldDescription className="text-xs">WhatsApp number inventory, serial debug attempts, OTP polling, finish/cancel handling.</FieldDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={configured ? 'default' : 'secondary'}>{configured ? 'configured' : 'token missing'}</Badge>
          <Button type="button" size="icon" variant="outline" title="Refresh 5sim inventory" aria-label="Refresh 5sim inventory" disabled={loading || running} onClick={() => void refresh()}>
            {loading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCcw size={14} />}
          </Button>
        </div>
      </div>
      <FieldGroup className="gap-3">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px_110px]">
          <Field>
            <FieldLabel>Country</FieldLabel>
            <Select value={country} disabled={running || loading || countries.length === 0} onValueChange={setCountry}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select country" />
              </SelectTrigger>
              <SelectContent>
                {countries.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Channel</FieldLabel>
            <Select value={operator} disabled={running || loading || operators.length === 0} onValueChange={setOperator}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select channel" />
              </SelectTrigger>
              <SelectContent>
                {operators.map((item) => <SelectItem key={item.operator} value={item.operator}>{item.operator} / {item.cost} / {item.count}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Max price</FieldLabel>
            <Input inputMode="decimal" value={maxPrice} disabled={running} onChange={(event) => setMaxPrice(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Attempts</FieldLabel>
            <Input inputMode="numeric" min={1} max={100} value={attempts} disabled={running} onChange={(event) => setAttempts(event.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">planned {stats.planned}</Badge>
            <Badge variant="outline">completed {stats.completed}</Badge>
            <Badge variant="default">success {stats.success}</Badge>
            <Badge variant={stats.failed > 0 ? 'destructive' : 'outline'}>failed {stats.failed}</Badge>
            {selectedInventory ? <Badge variant="secondary">stock {selectedInventory.count} / price {selectedInventory.cost}</Badge> : null}
            {activeOrderID ? <Badge variant="secondary">order {activeOrderID}</Badge> : null}
          </div>
          <div className="flex gap-2">
            {running ? (
              <Button type="button" variant="outline" size="sm" onClick={() => { cancelRequested.current = true; }}>
                <Square size={14} />
                Stop
              </Button>
            ) : null}
            <Button type="button" size="sm" disabled={!canStart} onClick={() => void runDebug()}>
              <Play size={14} />
              Run
            </Button>
          </div>
        </div>
        <div className="min-h-5 text-xs text-muted-foreground">{loadError || runLabel}</div>
        {Object.keys(failureReasons).length ? (
          <div className="grid gap-1 text-xs">
            <div className="font-medium text-destructive">Failure reasons</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(failureReasons).map(([reason, count]) => <Badge key={reason} variant="outline">{reason} x{count}</Badge>)}
            </div>
            {latestFailure ? <div className="break-words text-muted-foreground">Latest: {latestFailure}</div> : null}
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
  if (message.toLowerCase().includes('price')) return 'PRICE_LIMIT';
  if (message.toLowerCase().includes('inventory')) return 'NO_INVENTORY';
  return 'FAILED';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function clampInteger(value: number, min: number, maxValue: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(maxValue, Math.max(min, Math.floor(value)));
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
