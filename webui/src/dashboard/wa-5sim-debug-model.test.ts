import { describe, expect, test } from 'vitest';
import {
  compareFiveSimInventoryQuality,
  fiveSimCountryLabel,
  fiveSimFailureAction,
  fiveSimFailureReason,
  fiveSimProductLabel,
} from './wa-5sim-debug-model';

describe('fiveSimFailureAction', () => {
  test('bans a 5sim number when WA rejects or blocks it', () => {
    expect(fiveSimFailureAction('号码被拒绝/封禁')).toBe('ban');
    expect(fiveSimFailureAction('number is blocked by WA')).toBe('ban');
  });

  test('cancels the 5sim order on sms timeout', () => {
    expect(fiveSimFailureAction('OTP_TIMEOUT')).toBe('cancel');
  });
});

describe('fiveSimFailureReason', () => {
  test('groups rejected or blocked WA numbers separately from generic failures', () => {
    expect(fiveSimFailureReason('号码被拒绝/封禁')).toBe('NUMBER_REJECTED_OR_BLOCKED');
  });
});

describe('compareFiveSimInventoryQuality', () => {
  test('prefers available inventory with a higher rate', () => {
    const items = [
      { country: 'argentina', operator: 'high-stock', cost: 0.2, count: 100000, rate: 0 },
      { country: 'england', operator: 'better-rate', cost: 1.2, count: 10, rate: 95 },
    ];

    expect([...items].sort(compareFiveSimInventoryQuality)[0]?.operator).toBe('better-rate');
  });
});

describe('fiveSim labels', () => {
  test('displays 5sim country slugs in Chinese while keeping the original value available', () => {
    expect(fiveSimCountryLabel('argentina')).toBe('阿根廷');
    expect(fiveSimCountryLabel('antiguaandbarbuda')).toBe('安提瓜和巴布达');
  });

  test('displays whatsapp as WhatsApp service', () => {
    expect(fiveSimProductLabel('whatsapp')).toBe('WhatsApp');
  });
});
