export type ServiceType = "标准达" | "次日达" | "冷链";
export const SERVICE_TYPES: readonly ServiceType[] = ["标准达", "次日达", "冷链"];

/** 体积重折算系数：1m³ = 200kg */
export const VOLUMETRIC_FACTOR = 200;

export interface Tier {
  label: string;
  max: number;
  base: number;
  perKg: number;
}

export const TIER_TABLE: Record<ServiceType, Tier[]> = {
  标准达: [
    { label: "≤30kg", max: 30, base: 25, perKg: 1.5 },
    { label: "31-100kg", max: 100, base: 60, perKg: 1.2 },
    { label: "101-500kg", max: 500, base: 150, perKg: 0.9 },
    { label: ">500kg", max: Number.POSITIVE_INFINITY, base: 400, perKg: 0.7 }
  ],
  次日达: [
    { label: "≤30kg", max: 30, base: 40, perKg: 2.4 },
    { label: "31-100kg", max: 100, base: 100, perKg: 2.0 },
    { label: "101-500kg", max: 500, base: 260, perKg: 1.6 },
    { label: ">500kg", max: Number.POSITIVE_INFINITY, base: 700, perKg: 1.2 }
  ],
  冷链: [
    { label: "≤30kg", max: 30, base: 60, perKg: 3.0 },
    { label: "31-100kg", max: 100, base: 160, perKg: 2.6 },
    { label: "101-500kg", max: 500, base: 380, perKg: 2.2 },
    { label: ">500kg", max: Number.POSITIVE_INFINITY, base: 900, perKg: 1.8 }
  ]
};

export interface FeeLine {
  label: string;
  detail: string;
  amount: number;
}

export interface Quote {
  id: string;
  customer: string;
  origin: string;
  destination: string;
  route: string;
  service: ServiceType;
  actualWeight: number;
  volume: number;
  volumetricWeight: number;
  chargeableWeight: number;
  tierLabel: string;
  baseFee: number;
  discount: number;
  agreementId: string | null;
  agreementLabel: string;
  total: number;
  breakdown: FeeLine[];
  status: "草稿" | "已确认";
  createdAt: string;
  confirmedAt: string | null;
}

export interface Agreement {
  id: string;
  chainId: string;
  revision: number;
  customer: string;
  route: string;
  discount: number;
  effectiveFrom: string;
  effectiveTo: string;
  supersededBy: string | null;
  note: string;
  createdAt: string;
}

export interface ConflictItem {
  agreementId: string;
  revision: number;
  from: string;
  to: string;
  overlapFrom: string;
  overlapTo: string;
}

export interface ConflictNotice {
  id: string;
  customer: string;
  route: string;
  attemptedFrom: string;
  attemptedTo: string;
  attemptedDiscount: number;
  conflicts: ConflictItem[];
  createdAt: string;
}

export const STORAGE_KEYS = {
  quotes: "hxwlfront-13-quotes",
  agreements: "hxwlfront-13-agreements",
  conflicts: "hxwlfront-13-conflicts"
} as const;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function routeOf(origin: string, destination: string): string {
  return `${origin.trim()}-${destination.trim()}`;
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatDiscount(discount: number): string {
  return `${Number((discount * 10).toFixed(2))}折`;
}

export function pickTier(service: ServiceType, chargeableWeight: number): Tier {
  const tier = TIER_TABLE[service].find((t) => chargeableWeight <= t.max);
  return tier ?? TIER_TABLE[service][TIER_TABLE[service].length - 1];
}

export type AgreementStatus = "生效中" | "未生效" | "已过期" | "已被修订";

export function agreementStatus(agreement: Agreement, today: string): AgreementStatus {
  if (agreement.supersededBy) return "已被修订";
  if (today < agreement.effectiveFrom) return "未生效";
  if (today > agreement.effectiveTo) return "已过期";
  return "生效中";
}

export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/** 同客户同线路、生效期重叠且未被取代的协议（同一修订链内的新旧版本不算冲突） */
export function findConflicts(
  agreements: Agreement[],
  candidate: { chainId: string; customer: string; route: string; effectiveFrom: string; effectiveTo: string }
): ConflictItem[] {
  return agreements
    .filter(
      (a) =>
        a.chainId !== candidate.chainId &&
        !a.supersededBy &&
        a.customer === candidate.customer &&
        a.route === candidate.route &&
        rangesOverlap(candidate.effectiveFrom, candidate.effectiveTo, a.effectiveFrom, a.effectiveTo)
    )
    .map((a) => ({
      agreementId: a.id,
      revision: a.revision,
      from: a.effectiveFrom,
      to: a.effectiveTo,
      overlapFrom: candidate.effectiveFrom > a.effectiveFrom ? candidate.effectiveFrom : a.effectiveFrom,
      overlapTo: candidate.effectiveTo < a.effectiveTo ? candidate.effectiveTo : a.effectiveTo
    }));
}

/** 报价时取当天生效的协议；若存在多份（理论上被冲突拦截），取折扣最深的一份，保证确定性 */
export function activeAgreementFor(
  agreements: Agreement[],
  customer: string,
  route: string,
  today: string
): Agreement | null {
  const matches = agreements.filter(
    (a) =>
      !a.supersededBy &&
      a.customer === customer &&
      a.route === route &&
      a.effectiveFrom <= today &&
      today <= a.effectiveTo
  );
  matches.sort((a, b) => a.discount - b.discount);
  return matches[0] ?? null;
}

export interface PriceInput {
  service: ServiceType;
  actualWeight: number;
  volume: number;
}

export interface PriceSnapshot {
  volumetricWeight: number;
  chargeableWeight: number;
  tierLabel: string;
  baseFee: number;
  discount: number;
  agreementId: string | null;
  agreementLabel: string;
  total: number;
  breakdown: FeeLine[];
}

export function priceQuote(input: PriceInput, agreement: Agreement | null): PriceSnapshot {
  const volumetricWeight = round2(input.volume * VOLUMETRIC_FACTOR);
  const chargeableWeight = round2(Math.max(input.actualWeight, volumetricWeight));
  const tier = pickTier(input.service, chargeableWeight);
  const baseFee = round2(tier.base + tier.perKg * chargeableWeight);
  const discount = agreement ? agreement.discount : 1;
  const total = round2(baseFee * discount);
  const agreementLabel = agreement
    ? `${agreement.customer} ${agreement.route} v${agreement.revision}`
    : "";
  const breakdown: FeeLine[] = [
    {
      label: "基础运费",
      detail: `${input.service} · ${tier.label}档：${tier.base} + ${tier.perKg}×${chargeableWeight}kg`,
      amount: baseFee
    },
    {
      label: "协议折扣",
      detail: agreement
        ? `${agreementLabel} · ${formatDiscount(discount)}`
        : "无生效协议，按原价计",
      amount: -round2(baseFee - total)
    },
    {
      label: "应付合计",
      detail: `计费重量 ${chargeableWeight}kg（实际 ${input.actualWeight}kg / 体积重 ${volumetricWeight}kg 取大）`,
      amount: total
    }
  ];
  return {
    volumetricWeight,
    chargeableWeight,
    tierLabel: tier.label,
    baseFee,
    discount,
    agreementId: agreement?.id ?? null,
    agreementLabel,
    total,
    breakdown
  };
}

export function seedAgreements(): Agreement[] {
  const now = new Date().toISOString();
  return [
    {
      id: "agr-c1-v1",
      chainId: "chain-c1",
      revision: 1,
      customer: "海沃商贸",
      route: "上海-南京",
      discount: 0.9,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      supersededBy: null,
      note: "年度框架协议",
      createdAt: now
    },
    {
      id: "agr-c2-v1",
      chainId: "chain-c2",
      revision: 1,
      customer: "云仓食品",
      route: "杭州-合肥",
      discount: 0.85,
      effectiveFrom: "2026-03-01",
      effectiveTo: "2026-08-31",
      supersededBy: "agr-c2-v2",
      note: "冷链旺季价，已被 v2 取代",
      createdAt: now
    },
    {
      id: "agr-c2-v2",
      chainId: "chain-c2",
      revision: 2,
      customer: "云仓食品",
      route: "杭州-合肥",
      discount: 0.8,
      effectiveFrom: "2026-09-01",
      effectiveTo: "2027-02-28",
      supersededBy: null,
      note: "续签并加深折扣",
      createdAt: now
    }
  ];
}

export function seedQuotes(agreements: Agreement[]): Quote[] {
  const haiwo = agreements.find((a) => a.id === "agr-c1-v1") ?? null;
  const yuncang = agreements.find((a) => a.id === "agr-c2-v2") ?? null;
  const now = Date.now();

  const snap1 = priceQuote({ service: "标准达", actualWeight: 180, volume: 0.5 }, haiwo);
  const q1: Quote = {
    id: "quote-seed-1",
    customer: "海沃商贸",
    origin: "上海",
    destination: "南京",
    route: "上海-南京",
    service: "标准达",
    actualWeight: 180,
    volume: 0.5,
    ...snap1,
    status: "已确认",
    createdAt: new Date(now - 2 * 86400000).toISOString(),
    confirmedAt: new Date(now - 86400000).toISOString()
  };

  const snap2 = priceQuote({ service: "冷链", actualWeight: 95, volume: 0.8 }, yuncang);
  const q2: Quote = {
    id: "quote-seed-2",
    customer: "云仓食品",
    origin: "杭州",
    destination: "合肥",
    route: "杭州-合肥",
    service: "冷链",
    actualWeight: 95,
    volume: 0.8,
    ...snap2,
    status: "草稿",
    createdAt: new Date(now - 3600000).toISOString(),
    confirmedAt: null
  };

  return [q2, q1];
}
