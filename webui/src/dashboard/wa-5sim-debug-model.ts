export type FiveSimFailureAction = 'ban' | 'cancel';
export type FiveSimInventoryQuality = { count: number; cost: number; rate?: number };

const COUNTRY_LABELS: Record<string, string> = {
  afghanistan: '阿富汗',
  albania: '阿尔巴尼亚',
  algeria: '阿尔及利亚',
  angola: '安哥拉',
  antiguaandbarbuda: '安提瓜和巴布达',
  argentina: '阿根廷',
  armenia: '亚美尼亚',
  australia: '澳大利亚',
  austria: '奥地利',
  azerbaijan: '阿塞拜疆',
  bahamas: '巴哈马',
  bahrain: '巴林',
  bangladesh: '孟加拉国',
  barbados: '巴巴多斯',
  belarus: '白俄罗斯',
  belgium: '比利时',
  belize: '伯利兹',
  benin: '贝宁',
  bhutan: '不丹',
  bolivia: '玻利维亚',
  bosniaandherzegovina: '波黑',
  botswana: '博茨瓦纳',
  brazil: '巴西',
  brunei: '文莱',
  bulgaria: '保加利亚',
  burkinafaso: '布基纳法索',
  burundi: '布隆迪',
  cambodia: '柬埔寨',
  cameroon: '喀麦隆',
  canada: '加拿大',
  capeverde: '佛得角',
  centralafricanrepublic: '中非共和国',
  chad: '乍得',
  chile: '智利',
  china: '中国',
  colombia: '哥伦比亚',
  comoros: '科摩罗',
  congo: '刚果',
  costarica: '哥斯达黎加',
  croatia: '克罗地亚',
  cuba: '古巴',
  cyprus: '塞浦路斯',
  czechrepublic: '捷克',
  denmark: '丹麦',
  djibouti: '吉布提',
  dominica: '多米尼克',
  dominicanrepublic: '多米尼加共和国',
  ecuador: '厄瓜多尔',
  egypt: '埃及',
  elsalvador: '萨尔瓦多',
  england: '英国',
  equatorialguinea: '赤道几内亚',
  eritrea: '厄立特里亚',
  estonia: '爱沙尼亚',
  ethiopia: '埃塞俄比亚',
  finland: '芬兰',
  france: '法国',
  frenchguiana: '法属圭亚那',
  gabon: '加蓬',
  gambia: '冈比亚',
  georgia: '格鲁吉亚',
  germany: '德国',
  ghana: '加纳',
  greece: '希腊',
  grenada: '格林纳达',
  guatemala: '危地马拉',
  guinea: '几内亚',
  guineabissau: '几内亚比绍',
  guyana: '圭亚那',
  haiti: '海地',
  honduras: '洪都拉斯',
  hongkong: '中国香港',
  hungary: '匈牙利',
  india: '印度',
  indonesia: '印度尼西亚',
  ireland: '爱尔兰',
  israel: '以色列',
  italy: '意大利',
  ivorycoast: '科特迪瓦',
  jamaica: '牙买加',
  japan: '日本',
  jordan: '约旦',
  kazakhstan: '哈萨克斯坦',
  kenya: '肯尼亚',
  kosovo: '科索沃',
  kuwait: '科威特',
  kyrgyzstan: '吉尔吉斯斯坦',
  laos: '老挝',
  latvia: '拉脱维亚',
  lesotho: '莱索托',
  liberia: '利比里亚',
  libya: '利比亚',
  lithuania: '立陶宛',
  luxembourg: '卢森堡',
  macau: '中国澳门',
  madagascar: '马达加斯加',
  malawi: '马拉维',
  malaysia: '马来西亚',
  maldives: '马尔代夫',
  mali: '马里',
  mauritania: '毛里塔尼亚',
  mauritius: '毛里求斯',
  mexico: '墨西哥',
  moldova: '摩尔多瓦',
  mongolia: '蒙古',
  montenegro: '黑山',
  morocco: '摩洛哥',
  mozambique: '莫桑比克',
  myanmar: '缅甸',
  namibia: '纳米比亚',
  nepal: '尼泊尔',
  netherlands: '荷兰',
  newcaledonia: '新喀里多尼亚',
  newzealand: '新西兰',
  nicaragua: '尼加拉瓜',
  niger: '尼日尔',
  nigeria: '尼日利亚',
  northmacedonia: '北马其顿',
  norway: '挪威',
  oman: '阿曼',
  pakistan: '巴基斯坦',
  panama: '巴拿马',
  papuanewguinea: '巴布亚新几内亚',
  paraguay: '巴拉圭',
  peru: '秘鲁',
  philippines: '菲律宾',
  poland: '波兰',
  portugal: '葡萄牙',
  puertorico: '波多黎各',
  qatar: '卡塔尔',
  reunion: '留尼汪',
  romania: '罗马尼亚',
  russia: '俄罗斯',
  rwanda: '卢旺达',
  saintkittsandnevis: '圣基茨和尼维斯',
  saintlucia: '圣卢西亚',
  saintvincentandthegrenadines: '圣文森特和格林纳丁斯',
  saudiarabia: '沙特阿拉伯',
  senegal: '塞内加尔',
  serbia: '塞尔维亚',
  seychelles: '塞舌尔',
  sierraleone: '塞拉利昂',
  singapore: '新加坡',
  slovakia: '斯洛伐克',
  slovenia: '斯洛文尼亚',
  somalia: '索马里',
  southafrica: '南非',
  southkorea: '韩国',
  spain: '西班牙',
  srilanka: '斯里兰卡',
  sudan: '苏丹',
  suriname: '苏里南',
  swaziland: '斯威士兰',
  sweden: '瑞典',
  switzerland: '瑞士',
  taiwan: '中国台湾',
  tajikistan: '塔吉克斯坦',
  tanzania: '坦桑尼亚',
  thailand: '泰国',
  timorleste: '东帝汶',
  togo: '多哥',
  trinidadandtobago: '特立尼达和多巴哥',
  tunisia: '突尼斯',
  turkey: '土耳其',
  turkmenistan: '土库曼斯坦',
  uganda: '乌干达',
  ukraine: '乌克兰',
  unitedarabemirates: '阿联酋',
  unitedkingdom: '英国',
  unitedstates: '美国',
  uruguay: '乌拉圭',
  usa: '美国',
  uzbekistan: '乌兹别克斯坦',
  venezuela: '委内瑞拉',
  vietnam: '越南',
  yemen: '也门',
  zambia: '赞比亚',
  zimbabwe: '津巴布韦',
};

export function fiveSimCountryLabel(country: string) {
  return COUNTRY_LABELS[normalizeFiveSimKey(country)] || country;
}

export function fiveSimProductLabel(product: string) {
  return normalizeFiveSimKey(product) === 'whatsapp' ? 'WhatsApp' : product;
}

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

function normalizeFiveSimKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
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
