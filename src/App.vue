<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  SERVICE_LEVELS,
  VOLUMETRIC_FACTOR,
  activeAgreementFor,
  agreementDisplayStatus,
  findConflicts,
  priceQuote,
  routeKey,
  seedState,
  today,
  type Agreement,
  type ConflictRecord,
  type PersistedState,
  type Quote,
  type ServiceLevel,
} from "./domain";

const STORAGE_KEY = "hxwlfront-13-review";

const project = {
  industry: "物流",
  title: "物流报价复核台",
  subtitle:
    "录入起止城市、重量、体积与服务时效，按体积重（1m³=167kg）与实际重量取大选择计价档，再叠加生效中的协议折扣。确认后费用明细冻结，协议调整仅生成新修订，历史报价不重算。",
  stack: ["Vue3", "Vite", "TypeScript", "Pinia", "Element Plus"],
} as const;

function loadState(): PersistedState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && Array.isArray(parsed.quotes) && Array.isArray(parsed.agreements)) {
        return { conflicts: [], ...parsed };
      }
    } catch {
      // 数据损坏时回退到种子数据
    }
  }
  return seedState();
}

const state = loadState();
const quotes = ref<Quote[]>(state.quotes);
const agreements = ref<Agreement[]>(state.agreements);
const conflicts = ref<ConflictRecord[]>(state.conflicts);
/** 最近一次被阻止保存的记录 id，用于表单内联展示冲突区间（随状态持久化） */
const activeConflictId = ref<string | null>(state.activeConflictId ?? null);

function persist() {
  const payload: PersistedState = {
    version: 1,
    quotes: quotes.value,
    agreements: agreements.value,
    conflicts: conflicts.value,
    activeConflictId: activeConflictId.value,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/* ---------------- 报价录入 ---------------- */

const quoteForm = reactive({
  customer: "",
  origin: "",
  destination: "",
  weightKg: 0,
  volumeM3: 0,
  service: "标准达" as ServiceLevel,
  note: "",
});

const knownCustomers = computed(() => {
  const set = new Set<string>();
  agreements.value.forEach((a) => set.add(a.customer));
  quotes.value.forEach((q) => q.customer && set.add(q.customer));
  return [...set];
});

const quoteFormValid = computed(
  () =>
    quoteForm.customer.trim() !== "" &&
    quoteForm.origin.trim() !== "" &&
    quoteForm.destination.trim() !== "" &&
    quoteForm.service !== "" &&
    (quoteForm.weightKg > 0 || quoteForm.volumeM3 > 0)
);

/** 表单实时试算，保存时把该快照写入报价 */
const preview = computed(() => {
  if (!quoteFormValid.value) return null;
  return priceQuote(
    {
      customer: quoteForm.customer,
      origin: quoteForm.origin,
      destination: quoteForm.destination,
      weightKg: Number(quoteForm.weightKg) || 0,
      volumeM3: Number(quoteForm.volumeM3) || 0,
      service: quoteForm.service,
    },
    agreements.value
  );
});

const previewAgreement = computed(() =>
  preview.value?.agreementId
    ? agreements.value.find((a) => a.id === preview.value?.agreementId) ?? null
    : null
);

function submitQuote() {
  if (!preview.value) return;
  const quote: Quote = {
    id: crypto.randomUUID(),
    customer: quoteForm.customer.trim(),
    origin: quoteForm.origin.trim(),
    destination: quoteForm.destination.trim(),
    weightKg: Number(quoteForm.weightKg) || 0,
    volumeM3: Number(quoteForm.volumeM3) || 0,
    service: quoteForm.service,
    status: "草稿",
    note: quoteForm.note.trim() || "暂无备注",
    createdAt: new Date().toISOString(),
    confirmedAt: null,
    breakdown: preview.value,
  };
  quotes.value = [quote, ...quotes.value];
  Object.assign(quoteForm, {
    customer: "",
    origin: "",
    destination: "",
    weightKg: 0,
    volumeM3: 0,
    service: "标准达",
    note: "",
  });
  persist();
}

function confirmQuote(quote: Quote) {
  if (quote.status !== "草稿") return;
  quote.status = "已确认";
  quote.confirmedAt = new Date().toISOString();
  persist();
}

/** 仅草稿可按当前协议重新计价；已确认报价冻结，绝不重算 */
function repriceQuote(quote: Quote) {
  if (quote.status !== "草稿") return;
  quote.breakdown = priceQuote(quote, agreements.value);
  persist();
}

function removeQuote(quote: Quote) {
  if (quote.status !== "草稿") return;
  quotes.value = quotes.value.filter((item) => item.id !== quote.id);
  persist();
}

function quoteSummary(quote: Quote): string {
  const b = quote.breakdown;
  return [
    `${quote.customer} ${routeKey(quote.origin, quote.destination)} ${quote.service}`,
    `计费重${b.chargeableWeight}kg（${b.weightBasis}）· ${b.tierLabel} · 单价${b.unitPrice}元/kg`,
    `基础费${b.baseFee}元 - 协议优惠${b.discountAmount}元（v${b.agreementRevision ?? "-"} ${b.discountRate}%）= 应收${b.finalFee}元`,
  ].join("；");
}

function copyQuote(quote: Quote) {
  navigator.clipboard?.writeText(quoteSummary(quote));
}

/* ---------------- 协议管理与修订 ---------------- */

const agreementForm = reactive({
  customer: "",
  origin: "",
  destination: "",
  discountRate: 10,
  effectiveFrom: today(),
  effectiveTo: today(),
  note: "",
});

/** 修订模式：锁定客户与线路，基于源协议生成下一版本 */
const revisingOf = ref<Agreement | null>(null);
const agreementError = ref("");
const activeConflict = computed(
  () => conflicts.value.find((record) => record.id === activeConflictId.value) ?? null
);

function startRevision(agreement: Agreement) {
  revisingOf.value = agreement;
  Object.assign(agreementForm, {
    customer: agreement.customer,
    origin: agreement.origin,
    destination: agreement.destination,
    discountRate: agreement.discountRate,
    effectiveFrom: agreement.effectiveFrom,
    effectiveTo: agreement.effectiveTo,
    note: "",
  });
  agreementError.value = "";
}

function cancelRevision() {
  revisingOf.value = null;
  agreementError.value = "";
  activeConflictId.value = null;
  resetAgreementForm();
}

function resetAgreementForm() {
  Object.assign(agreementForm, {
    customer: "",
    origin: "",
    destination: "",
    discountRate: 10,
    effectiveFrom: today(),
    effectiveTo: today(),
    note: "",
  });
}

function saveAgreement() {
  agreementError.value = "";
  const candidate = {
    customer: agreementForm.customer.trim(),
    origin: agreementForm.origin.trim(),
    destination: agreementForm.destination.trim(),
    from: agreementForm.effectiveFrom,
    to: agreementForm.effectiveTo,
  };
  if (!candidate.customer || !candidate.origin || !candidate.destination) {
    agreementError.value = "请填写客户与起止城市。";
    return;
  }
  if (!candidate.from || !candidate.to || candidate.from > candidate.to) {
    agreementError.value = "生效期无效：生效开始日期不得晚于截止日期。";
    return;
  }
  const rate = Number(agreementForm.discountRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    agreementError.value = "折扣率需在 0-100 之间。";
    return;
  }

  // 同客户同线路生效期重叠：阻止保存并记录冲突区间
  const found = findConflicts(agreements.value, candidate, revisingOf.value?.chainId);
  if (found.length > 0) {
    const record: ConflictRecord = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      customer: candidate.customer,
      origin: candidate.origin,
      destination: candidate.destination,
      attemptedFrom: candidate.from,
      attemptedTo: candidate.to,
      attemptedRate: rate,
      conflicts: found,
    };
    conflicts.value = [record, ...conflicts.value].slice(0, 50);
    activeConflictId.value = record.id;
    persist();
    return;
  }

  const now = new Date().toISOString();
  if (revisingOf.value) {
    // 调整协议只生成新修订：旧版本标记为已取代，历史报价不受影响
    const source = revisingOf.value;
    const nextRevision =
      Math.max(...agreements.value.filter((a) => a.chainId === source.chainId).map((a) => a.revisionNo)) + 1;
    agreements.value = agreements.value.map((a) =>
      a.chainId === source.chainId && a.status === "active" ? { ...a, status: "superseded" as const } : a
    );
    agreements.value = [
      {
        id: crypto.randomUUID(),
        chainId: source.chainId,
        revisionNo: nextRevision,
        supersedesId: source.id,
        customer: source.customer,
        origin: source.origin,
        destination: source.destination,
        discountRate: rate,
        effectiveFrom: candidate.from,
        effectiveTo: candidate.to,
        status: "active",
        createdAt: now,
        note: agreementForm.note.trim() || `由 v${source.revisionNo} 修订生成`,
      },
      ...agreements.value,
    ];
  } else {
    const id = crypto.randomUUID();
    agreements.value = [
      {
        id,
        chainId: id,
        revisionNo: 1,
        supersedesId: null,
        customer: candidate.customer,
        origin: candidate.origin,
        destination: candidate.destination,
        discountRate: rate,
        effectiveFrom: candidate.from,
        effectiveTo: candidate.to,
        status: "active",
        createdAt: now,
        note: agreementForm.note.trim() || "暂无备注",
      },
      ...agreements.value,
    ];
  }
  revisingOf.value = null;
  activeConflictId.value = null;
  resetAgreementForm();
  persist();
}

function clearConflicts() {
  conflicts.value = [];
  activeConflictId.value = null;
  persist();
}

/** 修订链视图：按链分组，链内按版本号排序 */
const chains = computed(() => {
  const map = new Map<string, Agreement[]>();
  for (const agreement of agreements.value) {
    const list = map.get(agreement.chainId) ?? [];
    list.push(agreement);
    map.set(agreement.chainId, list);
  }
  return [...map.values()]
    .map((list) => [...list].sort((a, b) => a.revisionNo - b.revisionNo))
    .sort((a, b) => (b[b.length - 1].createdAt || "").localeCompare(a[a.length - 1].createdAt || ""));
});

/* ---------------- 列表、筛选与指标 ---------------- */

const statusFilter = ref("全部状态");
const serviceFilter = ref("全部服务");

const filteredQuotes = computed(() =>
  quotes.value.filter((quote) => {
    const statusOk = statusFilter.value === "全部状态" || quote.status === statusFilter.value;
    const serviceOk = serviceFilter.value === "全部服务" || quote.service === serviceFilter.value;
    return statusOk && serviceOk;
  })
);

const metrics = computed(() => [
  { label: "报价总数", value: quotes.value.length },
  { label: "已确认（冻结）", value: quotes.value.filter((q) => q.status === "已确认").length },
  { label: "生效中协议", value: agreements.value.filter((a) => agreementDisplayStatus(a) === "生效中").length },
  { label: "冲突拦截", value: conflicts.value.length },
]);

const chartRows = computed(() =>
  (["草稿", "已确认"] as const).map((status) => ({
    status,
    value: quotes.value.filter((q) => q.status === status).length,
  }))
);
const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

/* ---------------- 格式化 ---------------- */

const fmtMoney = (value: number) => `¥${value.toFixed(2)}`;
const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-");
const agreementOf = (id: string | null) => agreements.value.find((a) => a.id === id) ?? null;
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
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <!-- 报价录入与复核 -->
      <section class="workspace">
        <form class="panel" @submit.prevent="submitQuote">
          <h2>新增报价</h2>
          <div class="form-grid">
            <label>
              客户名称
              <input v-model="quoteForm.customer" list="known-customers" placeholder="如：海沃商贸" required />
              <datalist id="known-customers">
                <option v-for="name in knownCustomers" :key="name" :value="name" />
              </datalist>
            </label>
            <div class="field-pair">
              <label>
                起运城市
                <input v-model="quoteForm.origin" placeholder="如：上海" required />
              </label>
              <label>
                目的城市
                <input v-model="quoteForm.destination" placeholder="如：南京" required />
              </label>
            </div>
            <div class="field-pair">
              <label>
                实际重量（kg）
                <input v-model.number="quoteForm.weightKg" type="number" min="0" step="0.1" required />
              </label>
              <label>
                体积（m³）
                <input v-model.number="quoteForm.volumeM3" type="number" min="0" step="0.01" required />
              </label>
            </div>
            <label>
              服务时效
              <select v-model="quoteForm.service" required>
                <option v-for="level in SERVICE_LEVELS" :key="level" :value="level">{{ level }}</option>
              </select>
            </label>
            <label>
              备注
              <textarea v-model="quoteForm.note" placeholder="填写复核说明或现场备注" />
            </label>

            <div v-if="preview" class="preview">
              <p class="preview-title">实时试算（体积重系数 {{ VOLUMETRIC_FACTOR }}kg/m³）</p>
              <dl>
                <div><dt>体积重</dt><dd>{{ preview.volumetricWeight }}kg</dd></div>
                <div><dt>计费重（取大）</dt><dd>{{ preview.chargeableWeight }}kg · {{ preview.weightBasis }}</dd></div>
                <div><dt>计价档</dt><dd>{{ preview.tierLabel }} · {{ preview.unitPrice }}元/kg</dd></div>
                <div>
                  <dt>基础费</dt>
                  <dd>{{ fmtMoney(preview.baseFee) }}<template v-if="preview.minChargeApplied">（已按最低消费 {{ preview.minCharge }}元 计）</template></dd>
                </div>
                <div>
                  <dt>协议折扣</dt>
                  <dd v-if="previewAgreement">
                    {{ previewAgreement.customer }} v{{ previewAgreement.revisionNo }} · 优惠{{ preview.discountRate }}%
                    （-{{ fmtMoney(preview.discountAmount) }}）
                  </dd>
                  <dd v-else>无生效协议，按标准价</dd>
                </div>
                <div class="preview-total"><dt>应收</dt><dd>{{ fmtMoney(preview.finalFee) }}</dd></div>
              </dl>
            </div>
            <p v-else class="hint">填写客户、起止城市与重量/体积后自动试算。</p>

            <button type="submit" :disabled="!preview">计算并保存</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>报价列表</h2>
            <div class="toolbar-filters">
              <select v-model="statusFilter">
                <option>全部状态</option>
                <option>草稿</option>
                <option>已确认</option>
              </select>
              <select v-model="serviceFilter">
                <option>全部服务</option>
                <option v-for="level in SERVICE_LEVELS" :key="level">{{ level }}</option>
              </select>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filteredQuotes.length === 0" class="empty">暂无匹配报价</div>
            <article v-for="quote in filteredQuotes" :key="quote.id" class="record">
              <div class="record-head">
                <p class="record-title">
                  {{ quote.customer }} / {{ routeKey(quote.origin, quote.destination) }}
                </p>
                <span class="status" :class="{ frozen: quote.status === '已确认' }">
                  {{ quote.status }}<template v-if="quote.status === '已确认'"> · 已冻结</template>
                </span>
              </div>

              <div class="details">
                <span>服务时效：{{ quote.service }}</span>
                <span>实际重量：{{ quote.breakdown.actualWeight }}kg</span>
                <span>体积：{{ quote.volumeM3 }}m³（体积重 {{ quote.breakdown.volumetricWeight }}kg）</span>
                <span>计费重：{{ quote.breakdown.chargeableWeight }}kg · 取{{ quote.breakdown.weightBasis }}</span>
                <span>计价档：{{ quote.breakdown.tierLabel }} · {{ quote.breakdown.unitPrice }}元/kg</span>
                <span>
                  协议：<template v-if="quote.breakdown.agreementId">
                    v{{ quote.breakdown.agreementRevision }} · 优惠{{ quote.breakdown.discountRate }}%
                    <em v-if="agreementOf(quote.breakdown.agreementId)?.status === 'superseded'" class="muted">（此后已修订，不影响本单）</em>
                  </template>
                  <template v-else>无</template>
                </span>
              </div>

              <div class="fee-line">
                <span>基础费 {{ fmtMoney(quote.breakdown.baseFee) }}</span>
                <span>− 优惠 {{ fmtMoney(quote.breakdown.discountAmount) }}</span>
                <strong>= 应收 {{ fmtMoney(quote.breakdown.finalFee) }}</strong>
              </div>

              <p class="note">{{ quote.note }}</p>
              <p class="timestamps">
                计价时间：{{ fmtDateTime(quote.breakdown.pricedAt) }}
                <template v-if="quote.confirmedAt"> · 确认时间：{{ fmtDateTime(quote.confirmedAt) }}</template>
              </p>

              <div class="actions">
                <button v-if="quote.status === '草稿'" type="button" @click="confirmQuote(quote)">确认报价并冻结</button>
                <button v-if="quote.status === '草稿'" class="secondary" type="button" @click="repriceQuote(quote)">按当前协议重新计价</button>
                <button class="secondary" type="button" @click="copyQuote(quote)">复制摘要</button>
                <button v-if="quote.status === '草稿'" class="danger" type="button" @click="removeQuote(quote)">删除</button>
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
        </section>
      </section>

      <!-- 协议管理 -->
      <section class="workspace agreements">
        <form class="panel" @submit.prevent="saveAgreement">
          <h2>{{ revisingOf ? `生成修订：v${revisingOf.revisionNo} → v${revisingOf.revisionNo + 1}` : "新增客户协议" }}</h2>
          <p v-if="revisingOf" class="revision-banner">
            正在修订 {{ revisingOf.customer }} · {{ routeKey(revisingOf.origin, revisingOf.destination) }}。
            保存后旧版本标记为已取代，已确认报价保持冻结不重算。
          </p>
          <div class="form-grid">
            <label>
              客户名称
              <input v-model="agreementForm.customer" :disabled="!!revisingOf" list="known-customers" required />
            </label>
            <div class="field-pair">
              <label>
                起运城市
                <input v-model="agreementForm.origin" :disabled="!!revisingOf" required />
              </label>
              <label>
                目的城市
                <input v-model="agreementForm.destination" :disabled="!!revisingOf" required />
              </label>
            </div>
            <label>
              折扣率（%，优惠百分比）
              <input v-model.number="agreementForm.discountRate" type="number" min="0" max="100" step="0.5" required />
            </label>
            <div class="field-pair">
              <label>
                生效开始
                <input v-model="agreementForm.effectiveFrom" type="date" required />
              </label>
              <label>
                生效截止
                <input v-model="agreementForm.effectiveTo" type="date" required />
              </label>
            </div>
            <label>
              备注
              <textarea v-model="agreementForm.note" placeholder="如：续签上调折扣、季节性调价" />
            </label>

            <p v-if="agreementError" class="error">{{ agreementError }}</p>
            <div v-if="activeConflict" class="conflict-alert">
              <p class="conflict-title">
                保存被阻止：{{ activeConflict.customer }} · {{ routeKey(activeConflict.origin, activeConflict.destination) }}
                存在 {{ activeConflict.conflicts.length }} 段生效期重叠
              </p>
              <ul>
                <li v-for="item in activeConflict.conflicts" :key="item.agreementId">
                  与协议 v{{ item.revisionNo }}（{{ item.from }} ~ {{ item.to }}）重叠：
                  <strong>{{ item.overlapFrom }} ~ {{ item.overlapTo }}</strong>
                </li>
              </ul>
              <p class="muted">请调整生效期，或使用「生成修订」取代旧版本。</p>
            </div>

            <div class="actions">
              <button type="submit">{{ revisingOf ? "保存新修订" : "保存协议" }}</button>
              <button v-if="revisingOf" class="secondary" type="button" @click="cancelRevision">取消修订</button>
            </div>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>协议与修订链</h2>
            <span class="muted">同客户同线路仅允许一条生效期不重叠的生效协议</span>
          </div>

          <div class="record-grid">
            <div v-if="chains.length === 0" class="empty">暂无协议</div>
            <article v-for="chain in chains" :key="chain[0].chainId" class="record">
              <div class="record-head">
                <p class="record-title">{{ chain[0].customer }} / {{ routeKey(chain[0].origin, chain[0].destination) }}</p>
                <span class="status">{{ chain.length }} 个版本</span>
              </div>
              <ol class="chain">
                <li v-for="agreement in chain" :key="agreement.id" :class="{ superseded: agreement.status === 'superseded' }">
                  <div class="chain-row">
                    <span class="rev">v{{ agreement.revisionNo }}</span>
                    <span class="range">{{ agreement.effectiveFrom }} ~ {{ agreement.effectiveTo }}</span>
                    <span class="rate">优惠 {{ agreement.discountRate }}%</span>
                    <span class="status" :class="{ muted: agreement.status === 'superseded' }">
                      {{ agreementDisplayStatus(agreement) }}
                    </span>
                    <button
                      v-if="agreement.status === 'active'"
                      class="secondary small"
                      type="button"
                      @click="startRevision(agreement)"
                    >生成修订</button>
                  </div>
                  <p class="muted chain-note">{{ agreement.note }} · 创建于 {{ fmtDateTime(agreement.createdAt) }}</p>
                </li>
              </ol>
            </article>
          </div>

          <div v-if="conflicts.length > 0" class="conflict-log">
            <div class="toolbar">
              <h3>冲突拦截记录</h3>
              <button class="secondary small" type="button" @click="clearConflicts">清空记录</button>
            </div>
            <article v-for="record in conflicts" :key="record.id" class="conflict-item">
              <p>
                <strong>{{ record.customer }} · {{ routeKey(record.origin, record.destination) }}</strong>
                尝试保存 {{ record.attemptedFrom }} ~ {{ record.attemptedTo }}（优惠 {{ record.attemptedRate }}%）被阻止
                <span class="muted">{{ fmtDateTime(record.at) }}</span>
              </p>
              <ul>
                <li v-for="item in record.conflicts" :key="item.agreementId">
                  与 v{{ item.revisionNo }}（{{ item.from }} ~ {{ item.to }}）重叠区间：
                  <strong>{{ item.overlapFrom }} ~ {{ item.overlapTo }}</strong>
                </li>
              </ul>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
