// 物流报价复核台领域逻辑：计价、协议匹配、冲突检测、修订链
export type ServiceLevel = "标准达" | "次日达" | "冷链";

export const SERVICE_LEVELS: readonly ServiceLevel[] = ["标准达", "次日达", "冷链"];

/** 体积重折算系数：1 立方米 = 167kg（抛比 1:6000） */
export const VOLUMETRIC_FACTOR = 167;

export interface Agreement {
  id: string;
  /** 同一修订链共享的链标识 */
  chainId: string;
  revisionNo: number;
  supersedesId: string | null;
  customer: string;
  origin: string;
  destination: string;
  /** 优惠百分比，12 表示优惠 12% */
  discountRate: number;
  effectiveFrom: string; // YYYY-MM-DD，含当天
  effectiveTo: string; // YYYY-MM-DD，含当天
  status: "active" | "superseded";
  createdAt: string;
  note: string;
}

export interface FeeBreakdown {
  actualWeight: number;
  volumetricWeight: number;
  chargeableWeight: number;
  weightBasis: "实际重量" | "体积重量";
  tierLabel: string;
  unitPrice: number;
  minCharge: number;
  minChargeApplied: boolean;
  baseFee: number;
  agreementId: string | null;
  agreementRevision: number | null;
  discountRate: number;
  discountAmount: number;
  finalFee: number;
  pricedAt: string;
}

export interface Quote {
  id: string;
  customer: string;
  origin: string;
  destination: string;
  weightKg: number;
  volumeM3: number;
  service: ServiceLevel;
  status: "草稿" | "已确认";
  note: string;
  createdAt: string;
  confirmedAt: string | null;
  /** 确认后冻结，协议修订不得触发重算 */
  breakdown: FeeBreakdown;
}

export interface ConflictItem {
  agreementId: string;
  revisionNo: number;
  from: string;
  to: string;
  overlapFrom: string;
  overlapTo: string;
}

export interface ConflictRecord {
  id: string;
  at: string;
  customer: string;
  origin: string;
  destination: string;
  attemptedFrom: string;
  attemptedTo: string;
  attemptedRate: number;
  conflicts: ConflictItem[];
}

export interface PersistedState {
  version: 1;
  quotes: Quote[];
  agreements: Agreement[];
  conflicts: ConflictRecord[];
  /** 最近一次被阻止保存的记录 id，刷新后内联冲突提示仍可恢复 */
  activeConflictId?: string | null;
}

const TIER_LIMITS = [30, 100, 300, 1000, Number.POSITIVE_INFINITY];
const TIER_LABELS = ["≤30kg", "31-100kg", "101-300kg", "301-1000kg", ">1000kg"];

const RATES: Record<ServiceLevel, { unit: number[]; minCharge: number }> = {
  标准达: { unit: [3.2, 2.6, 2.1, 1.7, 1.4], minCharge: 45 },
  次日达: { unit: [5.5, 4.6, 3.9, 3.2, 2.8], minCharge: 80 },
  冷链: { unit: [8.0, 6.8, 5.9, 5.0, 4.4], minCharge: 120 },
};

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function routeKey(origin: string, destination: string): string {
  return `${origin.trim()}→${destination.trim()}`;
}

export function volumetricWeightOf(volumeM3: number): number {
  return round1(Math.max(0, volumeM3) * VOLUMETRIC_FACTOR);
}

export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

export interface AgreementCandidate {
  customer: string;
  origin: string;
  destination: string;
  from: string;
  to: string;
}

/**
 * 同客户同线路的生效中协议，生效期不得重叠。
 * 修订场景下排除本链（修订即取代旧版本，不构成冲突）。
 */
export function findConflicts(
  agreements: Agreement[],
  candidate: AgreementCandidate,
  excludeChainId?: string
): ConflictItem[] {
  const key = routeKey(candidate.origin, candidate.destination);
  return agreements
    .filter(
      (agreement) =>
        agreement.status === "active" &&
        agreement.chainId !== excludeChainId &&
        agreement.customer.trim() === candidate.customer.trim() &&
        routeKey(agreement.origin, agreement.destination) === key &&
        rangesOverlap(agreement.effectiveFrom, agreement.effectiveTo, candidate.from, candidate.to)
    )
    .map((agreement) => ({
      agreementId: agreement.id,
      revisionNo: agreement.revisionNo,
      from: agreement.effectiveFrom,
      to: agreement.effectiveTo,
      overlapFrom: agreement.effectiveFrom > candidate.from ? agreement.effectiveFrom : candidate.from,
      overlapTo: agreement.effectiveTo < candidate.to ? agreement.effectiveTo : candidate.to,
    }));
}

/** 报价日生效中的协议：状态 active 且报价日落入生效期 */
export function activeAgreementFor(
  agreements: Agreement[],
  customer: string,
  origin: string,
  destination: string,
  onDate: string
): Agreement | null {
  const key = routeKey(origin, destination);
  const matches = agreements.filter(
    (agreement) =>
      agreement.status === "active" &&
      agreement.customer.trim() === customer.trim() &&
      routeKey(agreement.origin, agreement.destination) === key &&
      agreement.effectiveFrom <= onDate &&
      onDate <= agreement.effectiveTo
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, item) => (item.revisionNo > best.revisionNo ? item : best));
}

export interface PriceInput {
  customer: string;
  origin: string;
  destination: string;
  weightKg: number;
  volumeM3: number;
  service: ServiceLevel;
}

export function priceQuote(input: PriceInput, agreements: Agreement[], now = new Date()): FeeBreakdown {
  const actualWeight = round1(Math.max(0, input.weightKg));
  const volumetricWeight = volumetricWeightOf(input.volumeM3);
  const chargeableWeight = round1(Math.max(actualWeight, volumetricWeight));
  const weightBasis = actualWeight >= volumetricWeight ? "实际重量" : "体积重量";

  const rate = RATES[input.service];
  const tierIndex = TIER_LIMITS.findIndex((limit) => chargeableWeight <= limit);
  const unitPrice = rate.unit[tierIndex];
  const rawFee = chargeableWeight * unitPrice;
  const minChargeApplied = rawFee < rate.minCharge;
  const baseFee = round2(Math.max(rawFee, rate.minCharge));

  const onDate = now.toISOString().slice(0, 10);
  const agreement = activeAgreementFor(agreements, input.customer, input.origin, input.destination, onDate);
  const discountRate = agreement?.discountRate ?? 0;
  const discountAmount = round2((baseFee * discountRate) / 100);
  const finalFee = round2(baseFee - discountAmount);

  return {
    actualWeight,
    volumetricWeight,
    chargeableWeight,
    weightBasis,
    tierLabel: TIER_LABELS[tierIndex],
    unitPrice,
    minCharge: rate.minCharge,
    minChargeApplied,
    baseFee,
    agreementId: agreement?.id ?? null,
    agreementRevision: agreement?.revisionNo ?? null,
    discountRate,
    discountAmount,
    finalFee,
    pricedAt: now.toISOString(),
  };
}

export function agreementDisplayStatus(agreement: Agreement, onDate = today()): string {
  if (agreement.status === "superseded") return `已被 v${agreement.revisionNo + 1} 取代`;
  if (agreement.effectiveTo < onDate) return "已过期";
  if (agreement.effectiveFrom > onDate) return "待生效";
  return "生效中";
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

export function seedState(): PersistedState {
  const agreements: Agreement[] = [
    {
      id: "ag-hw-v1",
      chainId: "chain-hw-sh-nj",
      revisionNo: 1,
      supersedesId: null,
      customer: "海沃商贸",
      origin: "上海",
      destination: "南京",
      discountRate: 10,
      effectiveFrom: "2025-01-01",
      effectiveTo: "2025-12-31",
      status: "superseded",
      createdAt: daysAgo(300),
      note: "年度框架协议初版",
    },
    {
      id: "ag-hw-v2",
      chainId: "chain-hw-sh-nj",
      revisionNo: 2,
      supersedesId: "ag-hw-v1",
      customer: "海沃商贸",
      origin: "上海",
      destination: "南京",
      discountRate: 12,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      status: "active",
      createdAt: daysAgo(200),
      note: "续签上调折扣",
    },
    {
      id: "ag-yc-v1",
      chainId: "chain-yc-hz-hf",
      revisionNo: 1,
      supersedesId: null,
      customer: "云仓食品",
      origin: "杭州",
      destination: "合肥",
      discountRate: 8,
      effectiveFrom: "2026-03-01",
      effectiveTo: "2027-02-28",
      status: "active",
      createdAt: daysAgo(120),
      note: "冷链专线协议",
    },
  ];

  const quoteSeeds: Array<PriceInput & { id: string; status: Quote["status"]; note: string; createdAt: string; confirmedAt: string | null }> = [
    {
      id: "q-seed-1",
      customer: "海沃商贸",
      origin: "上海",
      destination: "南京",
      weightKg: 180,
      volumeM3: 0.6,
      service: "标准达",
      status: "已确认",
      note: "月度集货批次",
      createdAt: daysAgo(6),
      confirmedAt: daysAgo(5),
    },
    {
      id: "q-seed-2",
      customer: "云仓食品",
      origin: "杭州",
      destination: "合肥",
      weightKg: 95,
      volumeM3: 0.9,
      service: "冷链",
      status: "草稿",
      note: "待确认温区后复核",
      createdAt: daysAgo(1),
      confirmedAt: null,
    },
  ];

  const quotes: Quote[] = quoteSeeds.map((seed) => ({
    id: seed.id,
    customer: seed.customer,
    origin: seed.origin,
    destination: seed.destination,
    weightKg: seed.weightKg,
    volumeM3: seed.volumeM3,
    service: seed.service,
    status: seed.status,
    note: seed.note,
    createdAt: seed.createdAt,
    confirmedAt: seed.confirmedAt,
    breakdown: priceQuote(seed, agreements, new Date(seed.createdAt)),
  }));

  return { version: 1, quotes, agreements, conflicts: [] };
}
