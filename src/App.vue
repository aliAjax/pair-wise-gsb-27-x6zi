<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  SERVICE_TYPES,
  STORAGE_KEYS,
  VOLUMETRIC_FACTOR,
  activeAgreementFor,
  agreementStatus,
  findConflicts,
  formatDiscount,
  priceQuote,
  routeOf,
  seedAgreements,
  seedQuotes,
  todayStr,
  type Agreement,
  type ConflictNotice,
  type Quote,
  type ServiceType
} from "./domain";

const project = {
  industry: "物流",
  title: "物流报价复核台",
  subtitle:
    "录入起止城市、重量、体积与服务时效，按体积重与实际重量取大选择计价档，再叠加生效中的协议折扣。协议调整只生成新修订，已确认报价的费用明细永久冻结。",
  stack: ["Vue3", "Vite", "TypeScript", "Pinia", "Element Plus"],
  metricLabels: ["报价总数", "已确认报价", "生效中协议", "冲突提示"]
} as const;

function loadList<T>(key: string, fallback: () => T[]): T[] {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback();
  try {
    return JSON.parse(raw) as T[];
  } catch {
    return fallback();
  }
}

const agreements = ref<Agreement[]>(loadList(STORAGE_KEYS.agreements, seedAgreements));
const quotes = ref<Quote[]>(loadList(STORAGE_KEYS.quotes, () => seedQuotes(agreements.value)));
const conflictNotices = ref<ConflictNotice[]>(loadList(STORAGE_KEYS.conflicts, () => []));

function persist() {
  localStorage.setItem(STORAGE_KEYS.quotes, JSON.stringify(quotes.value));
  localStorage.setItem(STORAGE_KEYS.agreements, JSON.stringify(agreements.value));
  localStorage.setItem(STORAGE_KEYS.conflicts, JSON.stringify(conflictNotices.value));
}

/* ---------- 报价录入与试算 ---------- */

const quoteForm = reactive({
  customer: "",
  origin: "",
  destination: "",
  weight: 0,
  volume: 0,
  service: "标准达" as ServiceType
});
const quoteError = ref("");
const quoteFilter = ref("全部状态");

const quotePreview = computed(() => {
  const route = routeOf(quoteForm.origin || "起点", quoteForm.destination || "终点");
  const customer = quoteForm.customer.trim();
  const agreement =
    customer && quoteForm.origin.trim() && quoteForm.destination.trim()
      ? activeAgreementFor(agreements.value, customer, route, todayStr())
      : null;
  return {
    route,
    agreement,
    snapshot: priceQuote(
      {
        service: quoteForm.service,
        actualWeight: Number(quoteForm.weight) || 0,
        volume: Number(quoteForm.volume) || 0
      },
      agreement
    )
  };
});

function validateQuoteForm(): string {
  if (!quoteForm.customer.trim()) return "请填写客户名称";
  if (!quoteForm.origin.trim() || !quoteForm.destination.trim()) return "请填写起止城市";
  if (quoteForm.origin.trim() === quoteForm.destination.trim()) return "起点与终点不能相同";
  if (!(Number(quoteForm.weight) > 0)) return "实际重量需大于 0";
  if (!(Number(quoteForm.volume) > 0)) return "体积需大于 0";
  return "";
}

function saveQuote(confirm: boolean) {
  quoteError.value = validateQuoteForm();
  if (quoteError.value) return;
  const { route, agreement, snapshot } = quotePreview.value;
  const quote: Quote = {
    id: crypto.randomUUID(),
    customer: quoteForm.customer.trim(),
    origin: quoteForm.origin.trim(),
    destination: quoteForm.destination.trim(),
    route,
    service: quoteForm.service,
    actualWeight: Number(quoteForm.weight),
    volume: Number(quoteForm.volume),
    ...snapshot,
    status: confirm ? "已确认" : "草稿",
    createdAt: new Date().toISOString(),
    confirmedAt: confirm ? new Date().toISOString() : null
  };
  quotes.value = [quote, ...quotes.value];
  Object.assign(quoteForm, { customer: "", origin: "", destination: "", weight: 0, volume: 0, service: "标准达" });
  persist();
}

/** 确认报价：冻结当前费用明细，之后不再重算 */
function confirmQuote(quote: Quote) {
  if (quote.status !== "草稿") return;
  quote.status = "已确认";
  quote.confirmedAt = new Date().toISOString();
  persist();
}

/** 仅草稿允许按当前协议重新试算；已确认报价永不重算 */
function repriceDraft(quote: Quote) {
  if (quote.status !== "草稿") return;
  const agreement = activeAgreementFor(agreements.value, quote.customer, quote.route, todayStr());
  Object.assign(quote, priceQuote(
    { service: quote.service, actualWeight: quote.actualWeight, volume: quote.volume },
    agreement
  ));
  persist();
}

function removeQuote(quote: Quote) {
  if (quote.status !== "草稿") return;
  quotes.value = quotes.value.filter((q) => q.id !== quote.id);
  persist();
}

const filteredQuotes = computed(() => {
  if (quoteFilter.value === "全部状态") return quotes.value;
  return quotes.value.filter((q) => q.status === quoteFilter.value);
});

/* ---------- 协议管理与修订链 ---------- */

const agreementForm = reactive({
  customer: "",
  origin: "",
  destination: "",
  discount: 0.9,
  effectiveFrom: todayStr(),
  effectiveTo: "",
  note: ""
});
const revising = ref<Agreement | null>(null);
const agreementError = ref("");
const agreementNotice = ref("");

function startRevise(agreement: Agreement) {
  revising.value = agreement;
  const [origin = "", destination = ""] = agreement.route.split("-");
  Object.assign(agreementForm, {
    customer: agreement.customer,
    origin,
    destination,
    discount: agreement.discount,
    effectiveFrom: agreement.effectiveFrom,
    effectiveTo: agreement.effectiveTo,
    note: ""
  });
  agreementError.value = "";
  agreementNotice.value = "";
}

function cancelRevise() {
  revising.value = null;
  Object.assign(agreementForm, {
    customer: "",
    origin: "",
    destination: "",
    discount: 0.9,
    effectiveFrom: todayStr(),
    effectiveTo: "",
    note: ""
  });
  agreementError.value = "";
}

function validateAgreementForm(): string {
  if (!agreementForm.customer.trim()) return "请填写客户名称";
  if (!agreementForm.origin.trim() || !agreementForm.destination.trim()) return "请填写线路起止城市";
  if (agreementForm.origin.trim() === agreementForm.destination.trim()) return "起点与终点不能相同";
  const discount = Number(agreementForm.discount);
  if (!(discount > 0 && discount <= 1)) return "折扣率需在 (0, 1] 之间，如 0.85 表示 85 折";
  if (!agreementForm.effectiveFrom || !agreementForm.effectiveTo) return "请填写生效起止日期";
  if (agreementForm.effectiveFrom > agreementForm.effectiveTo) return "生效起始日不能晚于截止日";
  return "";
}

function submitAgreement() {
  agreementError.value = validateAgreementForm();
  agreementNotice.value = "";
  if (agreementError.value) return;

  const base = revising.value;
  const candidate = {
    chainId: base ? base.chainId : crypto.randomUUID(),
    customer: agreementForm.customer.trim(),
    route: routeOf(agreementForm.origin, agreementForm.destination),
    effectiveFrom: agreementForm.effectiveFrom,
    effectiveTo: agreementForm.effectiveTo
  };

  const conflicts = findConflicts(agreements.value, candidate);
  if (conflicts.length > 0) {
    conflictNotices.value = [
      {
        id: crypto.randomUUID(),
        customer: candidate.customer,
        route: candidate.route,
        attemptedFrom: candidate.effectiveFrom,
        attemptedTo: candidate.effectiveTo,
        attemptedDiscount: Number(agreementForm.discount),
        conflicts,
        createdAt: new Date().toISOString()
      },
      ...conflictNotices.value
    ];
    persist();
    return;
  }

  const agreement: Agreement = {
    id: crypto.randomUUID(),
    chainId: candidate.chainId,
    revision: base ? base.revision + 1 : 1,
    customer: candidate.customer,
    route: candidate.route,
    discount: Number(agreementForm.discount),
    effectiveFrom: candidate.effectiveFrom,
    effectiveTo: candidate.effectiveTo,
    supersededBy: null,
    note: agreementForm.note.trim() || (base ? `由 v${base.revision} 修订生成` : "新建协议"),
    createdAt: new Date().toISOString()
  };

  if (base) {
    const target = agreements.value.find((a) => a.id === base.id);
    if (target) target.supersededBy = agreement.id;
    agreementNotice.value = `已生成修订 v${agreement.revision}，原 v${base.revision} 标记为已被修订；历史报价不受影响。`;
  }
  agreements.value = [...agreements.value, agreement];
  cancelRevise();
  persist();
}

function chainOf(agreement: Agreement): Agreement[] {
  return agreements.value
    .filter((a) => a.chainId === agreement.chainId)
    .sort((a, b) => a.revision - b.revision);
}

const sortedAgreements = computed(() =>
  [...agreements.value].sort(
    (a, b) =>
      a.customer.localeCompare(b.customer, "zh") ||
      a.route.localeCompare(b.route, "zh") ||
      b.revision - a.revision
  )
);

function dismissNotice(id: string) {
  conflictNotices.value = conflictNotices.value.filter((n) => n.id !== id);
  persist();
}

/* ---------- 指标与图表 ---------- */

const metrics = computed(() => [
  quotes.value.length,
  quotes.value.filter((q) => q.status === "已确认").length,
  agreements.value.filter((a) => agreementStatus(a, todayStr()) === "生效中").length,
  conflictNotices.value.length
]);

const chartRows = computed(() =>
  (["草稿", "已确认"] as const).map((status) => ({
    status,
    value: quotes.value.filter((q) => q.status === status).length
  }))
);

const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

function fmtMoney(n: number): string {
  return `¥${n.toFixed(2)}`;
}

function lineAmount(line: { label: string; amount: number }): string {
  if (line.amount === 0) return "—";
  if (line.amount < 0) return `-${fmtMoney(-line.amount)}`;
  return fmtMoney(line.amount);
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  return iso.slice(0, 16).replace("T", " ");
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业 · 可追溯报价复核</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="(label, index) in project.metricLabels" :key="label" class="metric">
          <span>{{ label }}</span>
          <strong>{{ metrics[index] }}</strong>
        </article>
      </section>

      <section v-if="conflictNotices.length" class="conflict-panel">
        <div class="conflict-head">
          <h2>协议冲突提示（已阻止保存）</h2>
          <span class="tag">刷新后保留，可逐条处理</span>
        </div>
        <article v-for="notice in conflictNotices" :key="notice.id" class="conflict-item">
          <p class="conflict-title">
            {{ notice.customer }} · {{ notice.route }}：拟保存
            {{ notice.attemptedFrom }} ~ {{ notice.attemptedTo }}（{{ formatDiscount(notice.attemptedDiscount) }}）
            与以下生效协议区间重叠
          </p>
          <ul>
            <li v-for="c in notice.conflicts" :key="c.agreementId">
              协议 v{{ c.revision }}：{{ c.from }} ~ {{ c.to }}，
              冲突区间 <strong>{{ c.overlapFrom }} ~ {{ c.overlapTo }}</strong>
            </li>
          </ul>
          <div class="conflict-foot">
            <span>{{ fmtTime(notice.createdAt) }}</span>
            <button class="secondary" type="button" @click="dismissNotice(notice.id)">已知悉</button>
          </div>
        </article>
      </section>

      <section class="workspace">
        <div class="side">
          <form class="panel" @submit.prevent="saveQuote(false)">
            <h2>新增报价</h2>
            <div class="form-grid">
              <label>
                客户名称
                <input v-model="quoteForm.customer" placeholder="如：海沃商贸" required />
              </label>
              <div class="form-row">
                <label>
                  起点城市
                  <input v-model="quoteForm.origin" placeholder="上海" required />
                </label>
                <label>
                  终点城市
                  <input v-model="quoteForm.destination" placeholder="南京" required />
                </label>
              </div>
              <div class="form-row">
                <label>
                  实际重量 kg
                  <input v-model.number="quoteForm.weight" type="number" min="0" step="0.1" required />
                </label>
                <label>
                  体积 m³
                  <input v-model.number="quoteForm.volume" type="number" min="0" step="0.01" required />
                </label>
              </div>
              <label>
                服务时效
                <select v-model="quoteForm.service">
                  <option v-for="s in SERVICE_TYPES" :key="s">{{ s }}</option>
                </select>
              </label>

              <div class="preview">
                <p class="preview-title">实时试算（体积重系数 {{ VOLUMETRIC_FACTOR }}kg/m³）</p>
                <div class="preview-grid">
                  <span>体积重</span><strong>{{ quotePreview.snapshot.volumetricWeight }} kg</strong>
                  <span>计费重量（取大）</span><strong>{{ quotePreview.snapshot.chargeableWeight }} kg</strong>
                  <span>计价档</span><strong>{{ quoteForm.service }} · {{ quotePreview.snapshot.tierLabel }}</strong>
                  <span>基础运费</span><strong>{{ fmtMoney(quotePreview.snapshot.baseFee) }}</strong>
                  <span>生效协议</span>
                  <strong v-if="quotePreview.agreement">
                    {{ quotePreview.agreementLabel }} · {{ formatDiscount(quotePreview.snapshot.discount) }}
                  </strong>
                  <strong v-else>无（按原价）</strong>
                  <span>预估合计</span><strong class="total">{{ fmtMoney(quotePreview.snapshot.total) }}</strong>
                </div>
              </div>

              <p v-if="quoteError" class="error">{{ quoteError }}</p>
              <div class="actions">
                <button type="submit">保存草稿</button>
                <button type="button" @click="saveQuote(true)">确认并冻结</button>
              </div>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitAgreement">
            <h2>{{ revising ? `修订协议（当前 v${revising.revision}）` : "新增客户协议" }}</h2>
            <p v-if="revising" class="hint">
              调整不会改动原协议，保存后生成 v{{ revising.revision + 1 }} 新修订，原版本标记为已被修订。
            </p>
            <div class="form-grid">
              <label>
                客户名称
                <input v-model="agreementForm.customer" :disabled="!!revising" required />
              </label>
              <div class="form-row">
                <label>
                  起点城市
                  <input v-model="agreementForm.origin" :disabled="!!revising" required />
                </label>
                <label>
                  终点城市
                  <input v-model="agreementForm.destination" :disabled="!!revising" required />
                </label>
              </div>
              <div class="form-row">
                <label>
                  折扣率（0-1）
                  <input v-model.number="agreementForm.discount" type="number" min="0.01" max="1" step="0.01" required />
                </label>
                <label>
                  生效起始日
                  <input v-model="agreementForm.effectiveFrom" type="date" required />
                </label>
              </div>
              <div class="form-row">
                <label>
                  生效截止日
                  <input v-model="agreementForm.effectiveTo" type="date" required />
                </label>
                <label>
                  备注
                  <input v-model="agreementForm.note" placeholder="选填" />
                </label>
              </div>
              <p v-if="agreementError" class="error">{{ agreementError }}</p>
              <p v-if="agreementNotice" class="ok">{{ agreementNotice }}</p>
              <div class="actions">
                <button type="submit">{{ revising ? "保存为新修订" : "保存协议" }}</button>
                <button v-if="revising" class="secondary" type="button" @click="cancelRevise">取消修订</button>
              </div>
            </div>
          </form>
        </div>

        <section class="list-panel">
          <div class="toolbar">
            <h2>报价列表</h2>
            <select v-model="quoteFilter">
              <option>全部状态</option>
              <option>草稿</option>
              <option>已确认</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filteredQuotes.length === 0" class="empty">暂无匹配报价</div>
            <article v-for="quote in filteredQuotes" :key="quote.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ quote.customer }} / {{ quote.route }}</p>
                <span class="status" :class="quote.status === '已确认' ? 'ok-status' : 'draft-status'">
                  {{ quote.status }}
                </span>
              </div>
              <div class="details">
                <span>服务时效: {{ quote.service }}</span>
                <span>实际重量: {{ quote.actualWeight }} kg</span>
                <span>体积: {{ quote.volume }} m³</span>
                <span>体积重: {{ quote.volumetricWeight }} kg</span>
                <span>计费重量: {{ quote.chargeableWeight }} kg</span>
                <span>计价档: {{ quote.tierLabel }}</span>
              </div>

              <table class="breakdown">
                <tbody>
                  <tr v-for="line in quote.breakdown" :key="line.label" :class="{ 'total-row': line.label === '应付合计' }">
                    <td>{{ line.label }}</td>
                    <td class="detail">{{ line.detail }}</td>
                    <td class="amount">{{ lineAmount(line) }}</td>
                  </tr>
                </tbody>
              </table>

              <p class="note" v-if="quote.status === '已确认'">
                🔒 费用明细已冻结（{{ fmtTime(quote.confirmedAt) }}），协议修订不会触发重算。
                <template v-if="quote.agreementLabel">引用协议：{{ quote.agreementLabel }}</template>
              </p>
              <p class="note" v-else>
                草稿快照生成于 {{ fmtTime(quote.createdAt) }}，可在确认前按当前协议重新试算。
              </p>

              <div class="actions">
                <button v-if="quote.status === '草稿'" type="button" @click="confirmQuote(quote)">确认并冻结</button>
                <button v-if="quote.status === '草稿'" class="secondary" type="button" @click="repriceDraft(quote)">重新试算</button>
                <button v-if="quote.status === '草稿'" class="danger" type="button" @click="removeQuote(quote)">删除</button>
                <span v-else class="locked">已确认报价不可修改、不可重算</span>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>

          <div class="toolbar agreements-toolbar">
            <h2>客户协议</h2>
            <span class="tag">仅支持新增与修订，不可删改</span>
          </div>

          <div class="record-grid">
            <div v-if="sortedAgreements.length === 0" class="empty">暂无协议</div>
            <article v-for="agreement in sortedAgreements" :key="agreement.id" class="record">
              <div class="record-head">
                <p class="record-title">
                  {{ agreement.customer }} / {{ agreement.route }}
                  <span class="rev">v{{ agreement.revision }}</span>
                </p>
                <span
                  class="status"
                  :class="{
                    'ok-status': agreementStatus(agreement, todayStr()) === '生效中',
                    'draft-status': agreementStatus(agreement, todayStr()) === '未生效',
                    'dead-status': agreementStatus(agreement, todayStr()) === '已过期' || agreementStatus(agreement, todayStr()) === '已被修订'
                  }"
                >
                  {{ agreementStatus(agreement, todayStr()) }}
                </span>
              </div>
              <div class="details">
                <span>折扣: {{ formatDiscount(agreement.discount) }}</span>
                <span>生效区间: {{ agreement.effectiveFrom }} ~ {{ agreement.effectiveTo }}</span>
              </div>
              <div class="chain">
                <span class="chain-label">修订链</span>
                <template v-for="(link, i) in chainOf(agreement)" :key="link.id">
                  <span v-if="i > 0" class="chain-arrow">→</span>
                  <span
                    class="chain-chip"
                    :class="{ current: link.id === agreement.id, dead: !!link.supersededBy }"
                  >v{{ link.revision }}</span>
                </template>
              </div>
              <p class="note">{{ agreement.note }}</p>
              <div class="actions">
                <button v-if="!agreement.supersededBy" class="secondary" type="button" @click="startRevise(agreement)">
                  修订（生成新版本）
                </button>
                <span v-else class="locked">已被后续修订取代，仅存档</span>
              </div>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
