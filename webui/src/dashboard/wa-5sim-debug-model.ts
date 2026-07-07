export type FiveSimFailureAction = 'ban' | 'cancel';
export type FiveSimInventoryQuality = { count: number; cost: number; rate?: number };

export function compareFiveSimInventoryQuality(a: FiveSimInventoryQuality, b: FiveSimInventoryQuality) {
  const aAvailable = a.count > 0 ? 1 : 0;
  const bAvailable = b.count > 0 ? 1 : 0;
  if (aAvailable !== bAvailable) return bAvailable - aAvailable;
  const aRate = a.rate ?? 0;
  const bRate = b.rate ?? 0;
  if (aRate !== bRate) return bRate - aRate;
  if (a.count !== b.count) return b.count - a.count;
  return a.cost - b.cost;
}

export function fiveSimFailureAction(message: string): FiveSimFailureAction {
  return waNumberRejectedOrBlocked(message) ? 'ban' : 'cancel';
}

export function fiveSimFailureReason(message: string) {
  if (waNumberRejectedOrBlocked(message)) return 'NUMBER_REJECTED_OR_BLOCKED';
  if (message.includes('OTP_TIMEOUT')) return 'OTP_TIMEOUT';
  if (message.includes('RUN_STOPPED')) return 'RUN_STOPPED';
  if (message.includes('5SIM_PHONE_UNUSABLE')) return 'PHONE_UNUSABLE';
  if (message.toLowerCase().includes('price') || message.includes('价格')) return 'PRICE_LIMIT';
  if (message.toLowerCase().includes('inventory') || message.includes('库存')) return 'NO_INVENTORY';
  return 'FAILED';
}

export function fiveSimFailureReasonLabel(reason: string) {
  switch (reason) {
    case 'NUMBER_REJECTED_OR_BLOCKED':
      return '号码被拒绝/封禁';
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
    case 'BAN_FAILED':
      return '坏号上报失败';
    case 'CANCEL_FAILED':
      return '取消失败';
    default:
      return '失败';
  }
}

export function localizedFiveSimErrorMessage(error: unknown) {
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

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function waNumberRejectedOrBlocked(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('blocked')
    || normalized.includes('banned')
    || normalized.includes('reject')
    || normalized.includes('封禁')
    || normalized.includes('封号')
    || normalized.includes('被封')
    || normalized.includes('拒绝');
}
