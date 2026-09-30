<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, type Exhibit, type OpStatus, type ReadingField } from './stores/exhibition';
import { fieldLabel, unit } from './services/merge';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy' | 'merge'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });
function stageLabel(stage: Exhibit['stage']) { return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage]; }

const tabletOptions = computed(() => [...store.knownTablets, '➕ 新增平板…']);
function onTabletChange(value: string) {
  if (value === '➕ 新增平板…') {
    const name = window.prompt('输入平板编号（如 平板-D4）');
    if (name) store.addTablet(name);
  } else {
    store.switchTablet(value);
  }
}

function opTypeLabel(type: string) {
  return ({ setCondition: '条件检查', setReading: '环境读数', sign: '签字', resolveDiscrepancy: '差异处理', addExhibit: '登记展品' } as Record<string, string>)[type] ?? type;
}
function opStatusColor(status: OpStatus) {
  return ({ pending: 'blue', conflict: 'orange', failed: 'red', merged: 'green', duplicate: 'grey' } as Record<OpStatus, string>)[status];
}
function opStatusLabel(status: OpStatus) {
  return ({ pending: '待合并', conflict: '冲突待复核', failed: '失败待重试', merged: '已合并', duplicate: '重复已作废' } as Record<OpStatus, string>)[status];
}

function conflictFields(exhibitId: string): ReadingField[] {
  return store.conflictedReadings(exhibitId).map((c) => c.field);
}
function activeReadings(exhibitId: string, field: ReadingField) {
  const found = store.conflictedReadings(exhibitId).find((c) => c.field === field);
  return found ? found.records : [];
}
function statusRecords(exhibitId: string) {
  return store.conflictedStatuses(exhibitId);
}
function reviewReasons(exhibitId: string) {
  return store.reviewReasonsFor(exhibitId);
}
function blockedReason(ex: Exhibit): string | null {
  if (reviewReasons(ex.id).length > 0) return '存在未完成复核（读数冲突或签字失效），复核完成前不能推进';
  if (!ex.signatures.some((s) => s.role === '借展方' && s.valid)) return '缺少借展方有效签字';
  if (store.discrepancies.some((d) => d.exhibitId === ex.id && !d.resolved)) return '存在未解决差异项';
  return null;
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-select
        :model-value="store.deviceId"
        :items="tabletOptions"
        density="compact"
        variant="outlined"
        hide-details
        class="tablet-select mr-3"
        @update:model-value="onTabletChange"
      />
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.queued" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：当前有 {{ store.queued }} 条变更在本地队列，联网后按记录编号和字段版本合并。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="store.syncQueue">确认同步</v-btn></template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">等待复核 / 待同步</div><div class="metric">{{ store.reviewCount }} / {{ store.queued }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="environment">{{ $t('environment') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
            <v-tab value="merge">
              合并与复核
              <v-badge v-if="store.reviewCount || store.queued" :content="String(store.reviewCount + store.queued)" color="red" inline class="ml-2" />
            </v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip v-if="reviewReasons(item.id).length" size="small" color="orange" class="mr-2">待复核</v-chip>
                      <v-chip size="small" :color="item.status.value === 'issue' ? 'red' : item.status.value === 'passed' ? 'green' : 'grey'">{{ item.status.value }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>读数版本</th><th>条件</th></tr></thead>
                <tbody>
                  <tr v-for="item in store.exhibits" :key="item.id">
                    <td>{{ item.code }}</td>
                    <td>
                      <span v-for="r in activeReadings(item.id, 'temperature')" :key="r.version + r.source" class="reading-chip">
                        {{ r.value }}{{ unit('temperature') }} <span class="reading-source">{{ r.source }} · v{{ r.version }}</span>
                      </span>
                      <span v-if="!activeReadings(item.id, 'temperature').length">{{ item.environment.temperature.value }}{{ unit('temperature') }}</span>
                    </td>
                    <td>
                      <span v-for="r in activeReadings(item.id, 'humidity')" :key="r.version + r.source" class="reading-chip">
                        {{ r.value }}{{ unit('humidity') }} <span class="reading-source">{{ r.source }} · v{{ r.version }}</span>
                      </span>
                      <span v-if="!activeReadings(item.id, 'humidity').length">{{ item.environment.humidity.value }}{{ unit('humidity') }}</span>
                    </td>
                    <td>
                      <span v-for="r in activeReadings(item.id, 'light')" :key="r.version + r.source" class="reading-chip">
                        {{ r.value }}{{ unit('light') }} <span class="reading-source">{{ r.source }} · v{{ r.version }}</span>
                      </span>
                      <span v-if="!activeReadings(item.id, 'light').length">{{ item.environment.light.value }}{{ unit('light') }}</span>
                    </td>
                    <td class="text-caption">
                      <div>温度 v{{ item.environment.temperature.version }} · {{ item.environment.temperature.source }}</div>
                      <div>湿度 v{{ item.environment.humidity.version }} · {{ item.environment.humidity.source }}</div>
                      <div>照度 v{{ item.environment.light.version }} · {{ item.environment.light.source }}</div>
                    </td>
                    <td>
                      <v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn>
                      <v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </v-window-item>

            <v-window-item value="discrepancy">
              <v-list>
                <v-list-item v-for="item in store.discrepancies" :key="item.id">
                  <v-list-item-title>{{ item.title }}</v-list-item-title>
                  <v-list-item-subtitle>展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }} · v{{ item.version }}</v-list-item-subtitle>
                  <template #append>
                    <v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </v-window-item>

            <v-window-item value="merge">
              <v-alert type="info" variant="tonal" class="mb-4">
                多平板断网期间的操作在联网后按「记录编号 + 字段版本」合并。读数冲突保留两版并标明来源，需保管员复核确认；任一改动会让原签字失效，复核完成前不能推进。
              </v-alert>

              <v-card v-if="store.reviewExhibits.length" class="mb-4">
                <v-card-title>等待复核（{{ store.reviewExhibits.length }}）</v-card-title>
                <v-card-text>
                  <v-expansion-panels>
                    <v-expansion-panel v-for="ex in store.reviewExhibits" :key="ex.id">
                      <v-expansion-panel-title>
                        <v-chip color="orange" size="small" class="mr-2">待复核</v-chip>
                        {{ ex.code }} · {{ ex.name }}
                      </v-expansion-panel-title>
                      <v-expansion-panel-text>
                        <v-list density="compact">
                          <v-list-item v-for="(reason, i) in reviewReasons(ex.id)" :key="i">
                            <v-list-item-title class="review-reason">⚠ {{ reason }}</v-list-item-title>
                          </v-list-item>
                        </v-list>
                        <div v-for="field in conflictFields(ex.id)" :key="field" class="mt-3">
                          <div class="text-subtitle-2 mb-1">{{ fieldLabel(field) }}冲突读数（请复核后采用一版）：</div>
                          <v-btn
                            v-for="r in activeReadings(ex.id, field)"
                            :key="r.version + r.source"
                            size="small"
                            variant="tonal"
                            class="mr-2 mb-1"
                            @click="store.confirmReading(ex.id, field, r.value)"
                          >
                            采用 {{ r.value }}{{ unit(field) }} · {{ r.source }}（v{{ r.version }}）
                          </v-btn>
                        </div>
                        <div v-if="statusRecords(ex.id).length > 1" class="mt-3">
                          <div class="text-subtitle-2 mb-1">条件冲突（请复核后采用一版）：</div>
                          <v-btn
                            v-for="r in statusRecords(ex.id)"
                            :key="r.version + r.source"
                            size="small"
                            variant="tonal"
                            class="mr-2 mb-1"
                            @click="store.confirmStatus(ex.id, r.value)"
                          >
                            采用 {{ r.value }} · {{ r.source }}（v{{ r.version }}）
                          </v-btn>
                        </div>
                      </v-expansion-panel-text>
                    </v-expansion-panel>
                  </v-expansion-panels>
                </v-card-text>
              </v-card>

              <v-card>
                <v-card-title>等待处理项（{{ store.waitingOps.length }}）</v-card-title>
                <v-card-text>
                  <v-list v-if="store.waitingOps.length">
                    <v-list-item v-for="op in store.waitingOps" :key="op.opId">
                      <v-list-item-title>
                        <v-chip size="small" :color="opStatusColor(op.status)" class="mr-2">{{ opStatusLabel(op.status) }}</v-chip>
                        {{ opTypeLabel(op.type) }} · 记录 {{ op.recordId }} · {{ op.source }}
                        <span v-if="op.field"> · {{ fieldLabel(op.field as ReadingField) }}</span>
                      </v-list-item-title>
                      <v-list-item-subtitle>
                        <div v-if="op.reason" class="review-reason">⚠ {{ op.reason }}</div>
                        <div class="text-caption">重试 {{ op.retries }} 次 · {{ new Date(op.createdAt).toLocaleString() }}</div>
                      </v-list-item-subtitle>
                      <template #append>
                        <v-btn v-if="op.status === 'failed'" size="small" color="deep-purple" variant="tonal" @click="store.retryOp(op.opId)">重试</v-btn>
                      </template>
                    </v-list-item>
                  </v-list>
                  <v-empty-state v-else title="没有等待处理项" subtitle="所有离线操作已合并完成" />
                </v-card-text>
              </v-card>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="blockedReason(selected)" type="warning" variant="tonal" class="mb-3">
                {{ blockedReason(selected) }}
              </v-alert>
              <div v-if="reviewReasons(selected.id).length" class="mb-3">
                <div class="text-subtitle-2">复核原因：</div>
                <div v-for="(reason, i) in reviewReasons(selected.id)" :key="i" class="review-reason">⚠ {{ reason }}</div>
              </div>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green">
                  <b>保管员点收</b>
                  <p>核对包装、封条和附件清单。签字时记录读数快照与未解决差异版本。</p>
                  <div v-for="sig in selected.signatures.filter((s) => s.role === '保管员')" :key="sig.source" class="mb-1">
                    <v-chip size="small" :color="sig.valid ? 'green' : 'red'" class="mr-1">{{ sig.source }} · {{ sig.valid ? '有效' : '已失效' }}</v-chip>
                    <span v-if="!sig.valid" class="text-caption review-reason">{{ sig.invalidReason }}</span>
                  </div>
                  <v-btn size="small" :disabled="selected.signatures.some((s) => s.role === '保管员' && s.source === store.deviceId && s.valid)" @click="store.sign(selected.id, '保管员')">
                    {{ selected.signatures.some((s) => s.role === '保管员' && s.source === store.deviceId && s.valid) ? '已签字' : '保管员签字' }}
                  </v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="orange">
                  <b>借展方确认</b>
                  <p>确认差异项及后续责任。任一改动会让原签字失效，复核完成前不能推进。</p>
                  <div v-for="sig in selected.signatures.filter((s) => s.role === '借展方')" :key="sig.source" class="mb-1">
                    <v-chip size="small" :color="sig.valid ? 'green' : 'red'" class="mr-1">{{ sig.source }} · {{ sig.valid ? '有效' : '已失效' }}</v-chip>
                    <span v-if="!sig.valid" class="text-caption review-reason">{{ sig.invalidReason }}</span>
                  </div>
                  <v-btn size="small" :disabled="selected.signatures.some((s) => s.role === '借展方' && s.source === store.deviceId && s.valid)" @click="store.sign(selected.id, '借展方')">
                    {{ selected.signatures.some((s) => s.role === '借展方' && s.source === store.deviceId && s.valid) ? '已签字' : '借展方签字' }}
                  </v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="purple">
                  <b>推进阶段</b>
                  <p>存在未解决差异、缺少借展方有效签字或未完成复核时不能推进。</p>
                  <v-btn size="small" color="deep-purple" :disabled="Boolean(blockedReason(selected))" @click="store.advance(selected.id)">推进到下一阶段</v-btn>
                </v-timeline-item>
              </v-timeline>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.tablet-select { width: 150px; }
.reading-chip { display: inline-block; margin-right: 8px; padding: 2px 8px; background: #ede9fe; border-radius: 4px; font-size: 13px; }
.reading-source { color: #6d28d9; font-size: 11px; }
.review-reason { color: #b45309; font-size: 13px; }
</style>
