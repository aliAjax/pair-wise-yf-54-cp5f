<script setup lang="ts">
import { computed, ref } from 'vue';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useExhibitionStore, __setNextMergeFailure } from './stores/exhibition';
import {
  FIELD_KEYS,
  FIELD_META,
  ROLES,
  STAGE_LABEL,
  gateReason,
  describeVariant,
  type Exhibit,
  type FieldKey,
  type FieldVersion,
  type QueueOp,
  type Role
} from './domain';

const store = useExhibitionStore();

// 现场网络可手动切换，演示“断网继续签字 / 联网合并”
const connected = ref(true);
const tab = ref<'exhibits' | 'review' | 'discrepancies'>('exhibits');
const selectedId = ref<string | null>(null);
const registerOpen = ref(false);

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');

const selected = computed<Exhibit | null>(() => (selectedId.value ? store.exhibitById(selectedId.value) ?? null : null));
const selectedDiscrepancies = computed(() =>
  selected.value ? store.discrepancies.filter((item) => item.exhibitId === selected.value!.id) : []
);
const selectedOpenDiscrepancies = computed(() => selectedDiscrepancies.value.filter((item) => item.status === 'open'));
const reviewExhibits = computed(() => store.exhibitsNeedingReview);

const editing = ref<Partial<Record<FieldKey, string>>>({});
const newDiscTitle = ref('');
const newDiscSeverity = ref<'minor' | 'major'>('minor');

const register = handleSubmit((values) => {
  store.addExhibit(values);
  registerOpen.value = false;
  resetForm();
});

function beginEdit(exhibit: Exhibit, key: FieldKey) {
  editing.value[key] = String(exhibit.fields[key].value);
}
function commitEdit(exhibit: Exhibit, key: FieldKey) {
  const raw = editing.value[key];
  if (raw === undefined || raw === '') return;
  const value = Number(raw);
  if (!Number.isNaN(value)) store.updateReading(exhibit.id, key, value);
  editing.value[key] = undefined;
}

function variantsOf(exhibit: Exhibit, key: FieldKey): FieldVersion[] {
  return exhibit.pendingVariants[key] ?? [];
}
function hasPendingVariants(exhibit: Exhibit) {
  return FIELD_KEYS.some((key) => (exhibit.pendingVariants[key]?.length ?? 0) > 0);
}
function reasonFor(exhibit: Exhibit) {
  return gateReason(exhibit, store.discrepancies);
}
function opTypeLabel(op: QueueOp) {
  return { upsert: '读数上报', sign: '签字', resolve: op.declareNew ? '登记差异' : '确认差异', advance: '推进阶段' }[op.type];
}
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
function selectExhibit(id: string) {
  selectedId.value = id;
  editing.value = {};
  newDiscTitle.value = '';
}
function addDiscrepancy(exhibit: Exhibit) {
  const title = newDiscTitle.value.trim();
  if (title) {
    store.addDiscrepancy(exhibit.id, title, newDiscSeverity.value);
    newDiscTitle.value = '';
  }
}

/* ---- 多平板/失败场景演示 ---- */
const remoteDevice = ref('B');
function simConflict() {
  if (selected.value) store.simulateRemoteConflict(selected.value.id, remoteDevice.value);
}
function simSign(role: Role) {
  if (selected.value) store.simulateRemoteSign(selected.value.id, role, remoteDevice.value);
}
function injectFailure() {
  // 让下一轮合并的第一项临时失败，原操作保留进重试队列
  __setNextMergeFailure((op) => (op.attempts === 0 ? `模拟网络中断：${opTypeLabel(op)} 未送达` : null));
  store.mergeNow();
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-btn-toggle v-model="store.device" mandatory color="white" divided class="mr-3" density="compact">
        <v-btn value="A">平板 A</v-btn>
        <v-btn value="B">平板 B</v-btn>
        <v-btn value="C">平板 C</v-btn>
      </v-btn-toggle>
      <v-switch
        :model-value="connected"
        color="success"
        hide-details
        density="compact"
        class="mr-3"
        @update:model-value="connected = !connected"
      >
        <template #label>
          <v-chip :color="connected ? 'green' : 'orange'" size="small" class="ml-2">
            {{ connected ? '在线·可合并' : '断网·本地暂存' }}
          </v-chip>
        </template>
      </v-switch>
      <v-btn prepend-icon="mdi-plus" @click="registerOpen = true">登记展品</v-btn>
    </v-app-bar>

    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!connected || store.queued > 0" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          <div v-if="!connected">网络已断开：保管员可继续核对读数、登记差异与签字，所有操作按记录编号与字段版本暂存本机，恢复后合并。</div>
          <div v-else>网络已恢复，存在 {{ store.queue.length }} 项本机待合并 / {{ store.inbox.length }} 项其他平板到达项。</div>
          <template #append>
            <v-btn v-if="connected && store.queued > 0" color="deep-purple" variant="tonal" class="mr-2" @click="store.mergeNow">
              立即合并
            </v-btn>
            <v-btn v-if="store.waitingRetry.length" color="error" variant="text" @click="store.retryFailed">
              重试 {{ store.waitingRetry.length }} 项
            </v-btn>
          </template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">到场点交 / 布展 / 归还</div><div class="metric">{{ store.stageCounts.arrival }} / {{ store.stageCounts.install }} / {{ store.stageCounts.return }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolvedCount }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">待复核记录（冲突/失效签字）</div><div class="metric" :class="{ warn: reviewExhibits.length }">{{ reviewExhibits.length }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">待合并 / 重试中</div><div class="metric">{{ store.queue.length + store.inbox.length }} / {{ store.waitingRetry.length }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="exhibits">展品与签字</v-tab>
            <v-tab value="review">复核工作台 ({{ reviewExhibits.length }})</v-tab>
            <v-tab value="discrepancies">差异项 ({{ store.unresolvedCount }})</v-tab>
          </v-tabs>

          <v-window v-model="tab">
            <!-- 展品列表 -->
            <v-window-item value="exhibits">
              <v-virtual-scroll :items="store.exhibits" height="440" item-height="104">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selectExhibit(item.id)">
                    <template #prepend>
                      <v-badge v-if="hasPendingVariants(item)" color="error" icon="mdi-alert-decagram" floating>
                        <v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar>
                      </v-badge>
                      <v-avatar v-else color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar>
                    </template>
                    <v-list-item-title>
                      {{ item.name }} · {{ item.code }}
                      <v-chip size="x-small" class="ml-2" :color="item.signatures.some((s) => !s.valid) ? 'error' : 'default'">
                        签字 {{ item.signatures.filter((s) => s.valid).length }}/{{ item.signatures.length }} 有效
                      </v-chip>
                    </v-list-item-title>
                    <v-list-item-subtitle>
                      {{ item.lender }} · {{ item.hall }} · {{ STAGE_LABEL[item.stage] }}
                      · 温 {{ item.fields.temperature.value }}℃ v{{ item.fields.temperature.version }}
                    </v-list-item-subtitle>
                    <template #append>
                      <v-chip v-if="hasPendingVariants(item)" color="red" size="small" class="mr-2">读数冲突待复核</v-chip>
                      <v-chip size="small" :color="reasonFor(item) ? 'orange' : 'green'">{{ reasonFor(item) ? '不可推进' : '可推进' }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <!-- 复核工作台 -->
            <v-window-item value="review">
              <v-list v-if="reviewExhibits.length">
                <v-list-item v-for="item in reviewExhibits" :key="item.id" @click="selectExhibit(item.id)">
                  <v-list-item-title>{{ item.code }} · {{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>
                    <v-chip v-for="key in FIELD_KEYS" :key="key" v-show="variantsOf(item, key).length" color="red" size="x-small" class="mr-1">
                      {{ FIELD_META[key].label }} {{ variantsOf(item, key).length + 1 }} 版并存
                    </v-chip>
                    <span v-if="item.signatures.some((s) => !s.valid)" class="text-error">存在失效签字</span>
                  </v-list-item-subtitle>
                  <template #append>
                    <v-btn color="deep-purple" variant="tonal" @click.stop="selectExhibit(item.id)">前往复核</v-btn>
                  </template>
                </v-list-item>
              </v-list>
              <v-alert v-else type="success" variant="tonal" class="ma-4">当前没有等待处理的复核项。</v-alert>
            </v-window-item>

            <!-- 差异项 -->
            <v-window-item value="discrepancies">
              <v-list>
                <v-list-item v-for="item in store.discrepancies" :key="item.id">
                  <template #prepend>
                    <v-icon :color="item.severity === 'major' ? 'red' : 'orange'">
                      {{ item.severity === 'major' ? 'mdi-alert-octagon' : 'mdi-alert-circle-outline' }}
                    </v-icon>
                  </template>
                  <v-list-item-title>{{ item.title }} <span class="text-caption text-grey-darken-1">#{{ item.id }} · v{{ item.version }} · 来源平板{{ item.origin }}</span></v-list-item-title>
                  <v-list-item-subtitle>
                    展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}
                    <template v-if="item.status === 'resolved'"> · 已由 {{ item.resolvedBy }} 解决{{ item.note ? `：${item.note}` : '' }}</template>
                  </v-list-item-subtitle>
                  <template #append>
                    <v-btn :disabled="item.status === 'resolved'" color="green" variant="tonal" @click="store.resolveDiscrepancy(item.id)">
                      {{ item.status === 'resolved' ? '已确认' : '确认解决' }}
                    </v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <!-- 合并队列 / 重试 -->
        <v-row class="mt-5">
          <v-col cols="12" md="6">
            <v-card>
              <v-card-title class="text-subtitle-1">等待处理项（本机队列 {{ store.queue.length }} / 收件箱 {{ store.inbox.length }}）</v-card-title>
              <v-list density="compact" class="queue-list">
                <v-list-item v-for="op in [...store.queue, ...store.inbox]" :key="op.opId">
                  <v-list-item-title>
                    <v-icon size="small" :color="op.attempts ? 'red' : 'grey'" class="mr-1">{{ op.attempts ? 'mdi-refresh' : 'mdi-clock-outline' }}</v-icon>
                    {{ opTypeLabel(op) }} · 平板{{ op.device }} · {{ fmtTime(op.at) }}
                    <v-chip v-if="op.attempts" color="error" size="x-small" class="ml-2">重试 {{ op.attempts }}</v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle class="text-error">{{ op.lastError }}</v-list-item-subtitle>
                </v-list-item>
                <v-list-item v-if="!store.queue.length && !store.inbox.length">
                  <v-list-item-subtitle>队列为空。</v-list-item-subtitle>
                </v-list-item>
              </v-list>
              <v-card-actions>
                <v-btn color="deep-purple" :disabled="!connected || store.queued === 0" @click="store.mergeNow">联网合并</v-btn>
                <v-btn color="error" variant="text" :disabled="!store.waitingRetry.length" @click="store.retryFailed">重试失败项</v-btn>
                <v-spacer />
                <v-btn variant="text" @click="store.resetAll">重置演示数据</v-btn>
              </v-card-actions>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-title class="text-subtitle-1">合并日志 / 复核原因</v-card-title>
              <v-list density="compact" class="queue-list">
                <v-list-item v-for="(entry, index) in store.logs" :key="index">
                  <v-list-item-subtitle :class="{
                    'text-error': entry.kind === 'error',
                    'text-deep-purple-darken-2': entry.kind === 'conflict',
                    'text-green-darken-2': entry.kind === 'success'
                  }">
                    {{ fmtTime(entry.at) }} · {{ entry.text }}
                  </v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </v-card>
          </v-col>
        </v-row>

        <!-- 登记展品 -->
        <v-dialog v-model="registerOpen" max-width="560">
          <v-card title="登记新展品（断网也可写入本机队列）">
            <v-card-text>
              <v-form @submit.prevent="register">
                <v-text-field v-model="code" label="展品编号" :error-messages="errors.code" />
                <v-text-field v-model="name" label="展品名称" :error-messages="errors.name" />
                <v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" />
                <v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" />
                <v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn>
              </v-form>
            </v-card-text>
          </v-card>
        </v-dialog>

        <!-- 展品详情：读数版本、冲突双版、签字快照、复核门禁 -->
        <v-dialog :model-value="Boolean(selected)" max-width="860" @update:model-value="(v: boolean) => !v && (selectedId = null)">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name} · ${STAGE_LABEL[selected.stage]}`">
            <v-card-text>
              <!-- 复核原因置顶 -->
              <v-alert :type="reasonFor(selected) ? 'warning' : 'success'" variant="tonal" density="compact" class="mb-4">
                <span v-if="reasonFor(selected)"><v-icon start size="small">mdi-shield-alert</v-icon>复核未完成，不能推进：{{ reasonFor(selected) }}</span>
                <span v-else><v-icon start size="small">mdi-shield-check</v-icon>门禁通过：读数无冲突、差异已解决、双方签字均有效。</span>
              </v-alert>

              <v-alert v-for="(text, index) in selected.reviewReasons.slice(-3)" :key="index" type="info" variant="text" density="compact" icon="mdi-file-search-outline">
                {{ text }}
              </v-alert>

              <!-- 环境读数（带版本/来源） -->
              <div class="section-title">环境检查读数（改动即抬升字段版本，并使旧签字失效）</div>
              <v-table density="compact">
                <thead><tr><th>字段</th><th>当前读数</th><th>断网改读数</th><th>冲突复核</th></tr></thead>
                <tbody>
                  <tr v-for="key in FIELD_KEYS" :key="key">
                    <td>{{ FIELD_META[key].label }}</td>
                    <td>
                      <strong>{{ selected.fields[key].value }}{{ FIELD_META[key].unit }}</strong>
                      <span class="text-caption"> v{{ selected.fields[key].version }}（基于 v{{ selected.fields[key].base }}，平板{{ selected.fields[key].origin }}）</span>
                    </td>
                    <td>
                      <template v-if="editing[key] === undefined">
                        <v-btn size="small" variant="text" prepend-icon="mdi-pencil-outline" @click="beginEdit(selected, key)">改读数</v-btn>
                      </template>
                      <v-text-field v-else :model-value="editing[key]" density="compact" style="max-width: 120px"
                        @update:model-value="editing[key] = $event" @keyup.enter="commitEdit(selected, key)">
                        <template #append-inner>
                          <v-icon size="small" @click="commitEdit(selected, key)">mdi-check</v-icon>
                        </template>
                      </v-text-field>
                    </td>
                    <td>
                      <template v-for="variant in variantsOf(selected, key)" :key="`${variant.version}-${variant.origin}`">
                        <div class="variant-row">
                          <v-chip color="red" size="small" variant="tonal">{{ describeVariant(variant, key) }}</v-chip>
                          <v-btn size="x-small" variant="text" @click="store.chooseVariant(selected.id, key, variant)">选定此版</v-btn>
                          <v-btn size="x-small" variant="text" @click="store.chooseVariant(selected.id, key, selected.fields[key])">保留本机版</v-btn>
                        </div>
                      </template>
                      <span v-if="!variantsOf(selected, key).length" class="text-caption text-grey">无冲突</span>
                    </td>
                  </tr>
                </tbody>
              </v-table>

              <v-row class="mt-3">
                <v-col cols="12" md="7">
                  <div class="section-title">差异处理（未解决差异阻断推进与旧签字）</div>
                  <v-list density="compact">
                    <v-list-item v-for="d in selectedDiscrepancies" :key="d.id">
                      <v-list-item-title>
                        <v-icon v-if="d.status === 'open'" color="red" size="small">mdi-alert-circle</v-icon>
                        <v-icon v-else color="green" size="small">mdi-check-circle</v-icon>
                        {{ d.title }}
                      </v-list-item-title>
                      <v-list-item-subtitle>{{ d.id }} · v{{ d.version }} · {{ d.status === 'open' ? '未解决' : `已由 ${d.resolvedBy} 确认` }}</v-list-item-subtitle>
                      <template #append>
                        <v-btn v-if="d.status === 'open'" size="small" color="green" variant="text" @click="store.resolveDiscrepancy(d.id)">确认解决</v-btn>
                      </template>
                    </v-list-item>
                  </v-list>
                  <div class="d-flex align-center mt-2">
                    <v-text-field v-model="newDiscTitle" density="compact" placeholder="登记新差异（断网可用）" hide-details class="mr-2" />
                    <v-select v-model="newDiscSeverity" :items="[{ title: '轻微', value: 'minor' }, { title: '重大', value: 'major' }]" density="compact" style="max-width: 110px" hide-details class="mr-2" />
                    <v-btn size="small" color="orange" variant="tonal" @click="addDiscrepancy(selected)">登记</v-btn>
                  </div>
                </v-col>
                <v-col cols="12" md="5">
                  <div class="section-title">签字（快照读数版本 + 未解决差异）</div>
                  <v-list density="compact">
                    <v-list-item v-for="sig in selected.signatures" :key="sig.id">
                      <v-list-item-title>
                        <v-icon :color="sig.valid ? 'green' : 'red'" size="small">{{ sig.valid ? 'mdi-certificate-outline' : 'mdi-certificate-off' }}</v-icon>
                        {{ sig.role }} · {{ sig.signer }} · 平板{{ sig.device }}
                      </v-list-item-title>
                      <v-list-item-subtitle>
                        {{ fmtTime(sig.at) }} · {{ sig.valid ? '有效' : '已失效' }}
                        <div v-if="!sig.valid" class="text-error">{{ sig.invalidateReason }}</div>
                      </v-list-item-subtitle>
                    </v-list-item>
                  </v-list>
                  <v-btn v-for="role in ROLES" :key="role" size="small" class="mr-2" variant="outlined" @click="store.sign(selected.id, role)">
                    {{ role }}签字
                  </v-btn>
                </v-col>
              </v-row>

              <v-divider class="my-4" />
              <div class="d-flex align-center">
                <v-btn color="deep-purple" prepend-icon="mdi-arrow-right-bold" @click="store.advance(selected.id)">推进到下一阶段</v-btn>
                <span class="text-caption text-grey ml-3">推进操作同样入队，合并端再次校验门禁。</span>
                <v-spacer />
                <v-btn-toggle v-model="remoteDevice" mandatory density="compact" variant="outlined">
                  <v-btn value="B">模拟平板B</v-btn>
                  <v-btn value="C">模拟平板C</v-btn>
                </v-btn-toggle>
              </div>

              <!-- 多平板场景模拟 -->
              <v-card variant="tonal" class="mt-4" color="grey-lighten-4">
                <v-card-text>
                  <div class="section-title">多平板场景模拟（操作进入“其他平板”收件箱，点合并观察结果）</div>
                  <v-btn size="small" class="mr-2 mb-1" prepend-icon="mdi-swap-horizontal" @click="simConflict">制造温度读数分叉冲突</v-btn>
                  <v-btn size="small" class="mr-2 mb-1" prepend-icon="mdi-vector-difference" @click="simSign('借展方')">他板借展方签字</v-btn>
                  <v-btn size="small" class="mr-2 mb-1" prepend-icon="mdi-wifi-off" @click="injectFailure">下轮合并注入网络失败（验证重试保留原操作）</v-btn>
                  <v-btn
                    v-for="d in selectedOpenDiscrepancies"
                    :key="d.id" size="small" class="mr-2 mb-1" prepend-icon="mdi-account-check-outline"
                    @click="store.simulateRemoteResolve(d.id, remoteDevice)"
                  >
                    他板先确认差异 {{ d.id }}
                  </v-btn>
                </v-card-text>
              </v-card>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 28px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.section-title { font-weight: 700; font-size: 13px; color: #4c1d95; margin: 10px 0 6px; }
.queue-list { max-height: 240px; overflow-y: auto; }
.variant-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
</style>
