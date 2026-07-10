import { describe, expect, test } from 'vitest';
import { createFiveSimDebugSession, selectActiveFiveSimTask } from './wa-5sim-debug-session';

describe('createFiveSimDebugSession', () => {
  test('hydrates the visible run state from backend tasks after a page refresh', () => {
    const session = createFiveSimDebugSession();

    session.setState({
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          stop_requested: false,
          country: 'england',
          operator: 'virtual34',
          product: 'whatsapp',
          success_target: 2,
          stats: { target: 2, completed: 1, success: 0, failed: 1 },
          current_attempt: 2,
          active_order: { id: 123, status: 'PENDING', sms_count: 0 },
          failure_reasons: { OTP_TIMEOUT: 1 },
          logs: ['09:30:00 第 2 轮：等待短信'],
          created_at: '2026-07-10T09:30:00Z',
          updated_at: '2026-07-10T09:31:00Z',
        },
      ],
    });

    const snapshot = session.getSnapshot();
    expect(snapshot.running).toBe(true);
    expect(snapshot.activeTaskCount).toBe(1);
    expect(snapshot.activeTaskID).toBe('task-1');
    expect(snapshot.activeOrderID).toBe(123);
    expect(snapshot.stats.failed).toBe(1);
    expect(snapshot.logs.at(-1)).toContain('等待短信');
  });

  test('selects the newest active backend task before completed history', () => {
    const task = selectActiveFiveSimTask([
      { id: 'done', status: 'succeeded', created_at: '2026-07-10T09:20:00Z', updated_at: '2026-07-10T09:21:00Z', country: 'england', operator: 'virtual34', product: 'whatsapp', success_target: 1, stats: { target: 1, completed: 1, success: 1, failed: 0 }, current_attempt: 1, failure_reasons: {}, logs: [] },
      { id: 'older', status: 'running', created_at: '2026-07-10T09:25:00Z', updated_at: '2026-07-10T09:26:00Z', country: 'england', operator: 'virtual34', product: 'whatsapp', success_target: 1, stats: { target: 1, completed: 0, success: 0, failed: 0 }, current_attempt: 1, failure_reasons: {}, logs: [] },
      { id: 'newer', status: 'stopping', created_at: '2026-07-10T09:30:00Z', updated_at: '2026-07-10T09:31:00Z', country: 'england', operator: 'virtual34', product: 'whatsapp', success_target: 1, stats: { target: 1, completed: 0, success: 0, failed: 0 }, current_attempt: 1, failure_reasons: {}, logs: [] },
    ]);

    expect(task?.id).toBe('newer');
  });
});
