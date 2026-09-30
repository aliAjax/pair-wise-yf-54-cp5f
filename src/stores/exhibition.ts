import { defineStore } from 'pinia';
import {
  FIELD_KEYS,
  STAGE_ORDER,
  fingerprintOf,
  gateReason,
  processQueue,
  revalidateSignatures,
  resolveVariant,
  snapshotOf,
  type Discrepancy,
  type Exhibit,
  type FieldKey,
  type FieldVersion,
  type MergeReport,
  type QueueOp,
  type Role,
  type Signature,
  type Stage
} from '../domain';

const STORAGE_KEY = 'yf54-exhibition-state-v2';

interface MergeLogEntry { at: number; text: string; kind: 'info' | 'conflict' | 'error' | 'success'; }

interface State {
  device: string;
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  /** 本机离线产生、等待合并的操作（含历史失败的重试项） */
  queue: QueueOp[];
  /** 网络恢复后从其他平板到达、等待合并的操作 */
  inbox: QueueOp[];
  lastReport: MergeReport | null;
  logs: MergeLogEntry[];
  seq: number;
}

function fv(value: number, version = 1, origin = 'seed'): FieldVersion {
  return { value, version, base: version - 1, origin };
}

function seed(): State {
  const exhibits: Exhibit[] = Array.from({ length: 24 }, (_, index) => {
    const id = `ex-${index + 1}`;
    const fields = {
      temperature: fv(20 + (index % 3)),
      humidity: fv(48 + (index % 8)),
      light: fv(120 + index * 3)
    } as Exhibit['fields'];
    const exhibit: Exhibit = {
      id,
      code: `M${String(index + 1).padStart(3, '0')}`,
      name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
      lender: index % 2 ? '西北博物馆' : '私人借展方',
      hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
      stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
      fields,
      signatures: [],
      pendingVariants: {},
      reviewReasons: [],
      updatedAt: Date.now()
    };
    return exhibit;
  });

  const discrepancies: Discrepancy[] = [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', status: 'open', version: 1, origin: 'seed' },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', status: 'open', version: 1, origin: 'seed' }
  ];

  // 预置若干签字（对当前读数与差异状态做快照）
  const seedSign = (exhibit: Exhibit, role: Role) => {
    const sig: Signature = {
      id: `sig-seed-${exhibit.id}-${role}`,
      role,
      signer: role,
      device: 'seed',
      at: Date.now() - 3600_000,
      snapshot: snapshotOf(exhibit, discrepancies),
      discrepancySnapshot: discrepancies.filter((d) => d.exhibitId === exhibit.id && d.status === 'open').map((d) => d.id),
      fingerprint: '',
      valid: true
    };
    sig.fingerprint = fingerprintOf(exhibit, sig.discrepancySnapshot);
    exhibit.signatures.push(sig);
  };
  for (let i = 0; i < 5; i++) {
    seedSign(exhibits[i], '保管员');
    seedSign(exhibits[i], '借展方');
  }
  for (let i = 5; i < 10; i++) seedSign(exhibits[i], '保管员');

  return {
    device: 'A',
    exhibits,
    discrepancies,
    queue: [],
    inbox: [],
    lastReport: null,
    logs: [{ at: Date.now(), text: '初始数据载入：签字已对读数版本与未解决差异留痕', kind: 'info' }],
    seq: 1
  };
}

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return JSON.parse(saved) as State;
    } catch {
      // 损坏的持久化数据回落到种子
    }
  }
  return seed();
}

let failureInject: ((op: QueueOp) => string | null) | null = null;
/** 测试用：让下一轮合并中满足条件的操作临时失败（模拟网络/服务端错误） */
export function __setNextMergeFailure(fn: ((op: QueueOp) => string | null) | null) {
  failureInject = fn;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => item.status === 'open'),
    unresolvedCount: (state) => state.discrepancies.filter((item) => item.status === 'open').length,
    queued: (state) => state.queue.length + state.inbox.length,
    waitingRetry: (state) => state.queue.filter((op) => op.attempts > 0),
    exhibitsNeedingReview: (state) =>
      state.exhibits.filter(
        (item) =>
          Object.values(item.pendingVariants).some((variants) => variants && variants.length > 0) ||
          item.signatures.some((sig) => !sig.valid)
      ),
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    exhibitById: (state) => (id: string) => state.exhibits.find((item) => item.id === id)
  },
  actions: {
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state));
    },
    nextId(prefix: string) {
      const value = `${prefix}-${this.seq}-${Date.now().toString(36)}`;
      this.seq += 1;
      return value;
    },
    log(text: string, kind: MergeLogEntry['kind'] = 'info') {
      this.logs.unshift({ at: Date.now(), text, kind });
      if (this.logs.length > 80) this.logs.length = 80;
    },
    switchDevice(device: string) {
      this.device = device;
      this.persist();
    },

    openDiscrepanciesFor(exhibitId: string) {
      return this.discrepancies.filter((item) => item.exhibitId === exhibitId && item.status === 'open');
    },

    addExhibit(payload: { code: string; name: string; lender: string; hall: string }) {
      const id = `ex-${Date.now()}`;
      const fields = {
        temperature: { value: 20, version: 1, base: 0, origin: this.device },
        humidity: { value: 50, version: 1, base: 0, origin: this.device },
        light: { value: 150, version: 1, base: 0, origin: this.device }
      } as Exhibit['fields'];
      this.exhibits.unshift({
        id,
        ...payload,
        stage: 'arrival',
        fields,
        signatures: [],
        pendingVariants: {},
        reviewReasons: [],
        updatedAt: Date.now()
      });
      this.enqueue({ type: 'upsert', recordId: id, fields });
      this.log(`平板${this.device} 登记展品 ${payload.code}（断网暂存）`);
      this.persist();
    },

    /** 断网继续：本地立即改动并入队，读数版本 +1，base 指向改动前版本 */
    updateReading(id: string, key: FieldKey, value: number) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || Number.isNaN(value)) return;
      const prev = exhibit.fields[key];
      const next: FieldVersion = { value, version: prev.version + 1, base: prev.version, origin: this.device };
      exhibit.fields[key] = next;
      revalidateSignatures(exhibit, this.discrepancies);
      exhibit.updatedAt = Date.now();
      this.enqueue({
        type: 'upsert',
        recordId: id,
        fields: { [key]: next } as Partial<Record<FieldKey, FieldVersion>>
      });
      this.log(`平板${this.device} 离线记录 ${exhibit.code} 读数 v${next.version}（基于 v${prev.version}）`);
      this.persist();
    },

    /** 签字必须快照读数版本与未解决差异版本；任一改动都会让原签字失效 */
    sign(id: string, role: Role, signer?: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const openIds = this.openDiscrepanciesFor(id).map((item) => item.id);
      const sig: Signature = {
        id: this.nextId('sig'),
        role,
        signer: signer || role,
        device: this.device,
        at: Date.now(),
        snapshot: snapshotOf(exhibit, this.discrepancies),
        discrepancySnapshot: openIds,
        fingerprint: '',
        valid: true
      };
      sig.fingerprint = fingerprintOf(exhibit, openIds);
      exhibit.signatures.push(sig);
      this.enqueue({ type: 'sign', recordId: id, signature: sig });
      this.log(`${role}在平板${this.device} 对 ${exhibit.code} 签字，快照 ${sig.fingerprint}`);
      this.persist();
    },

    addDiscrepancy(exhibitId: string, title: string, severity: Discrepancy['severity']) {
      const disc: Discrepancy = {
        id: this.nextId('d'),
        exhibitId,
        title,
        severity,
        status: 'open',
        version: 1,
        origin: this.device
      };
      this.discrepancies.push(disc);
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (exhibit) revalidateSignatures(exhibit, this.discrepancies);
      // 差异的新增同样作为一项变更参与合并（重复处理幂等）
      this.enqueue({
        type: 'resolve',
        discrepancyId: disc.id,
        recordId: exhibitId,
        declareNew: true,
        discrepancy: { id: disc.id, exhibitId, title, severity },
        note: `新增差异：${title}`
      });
      this.log(`平板${this.device} 登记差异 ${disc.id}：${title}`);
      this.persist();
    },

    /** 确认差异解决；合并时若他人已确认则跳过，不覆盖其确认人与意见 */
    resolveDiscrepancy(id: string, note?: string) {
      const disc = this.discrepancies.find((item) => item.id === id);
      if (!disc || disc.status === 'resolved') return;
      disc.status = 'resolved';
      disc.version += 1;
      disc.resolvedBy = `平板${this.device}`;
      disc.resolvedAt = Date.now();
      disc.note = note;
      const exhibit = this.exhibits.find((item) => item.id === disc.exhibitId);
      if (exhibit) revalidateSignatures(exhibit, this.discrepancies);
      this.enqueue({ type: 'resolve', discrepancyId: id, recordId: disc.exhibitId, resolvedBy: `平板${this.device}`, note });
      this.log(`平板${this.device} 确认差异 ${id} 已解决（v${disc.version}）`);
      this.persist();
    },

    /** 推进门禁：冲突、未解决差异、失效签字或缺签字都不能推进 */
    advance(id: string): string | null {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return '记录不存在';
      const reason = gateReason(exhibit, this.discrepancies);
      if (reason) {
        this.log(`${exhibit.code} 推进被拦截：${reason}`, 'error');
        return reason;
      }
      const idx = STAGE_ORDER.indexOf(exhibit.stage);
      exhibit.stage = STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)];
      exhibit.updatedAt = Date.now();
      this.enqueue({ type: 'advance', recordId: id, stage: exhibit.stage });
      this.log(`${exhibit.code} 复核通过，推进到${exhibit.stage}`, 'success');
      this.persist();
      return null;
    },

    /** 复核人选定冲突读数中的一版 */
    chooseVariant(exhibitId: string, key: FieldKey, chosen: FieldVersion, reviewer?: string) {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      const merged = resolveVariant(exhibit, key, chosen, reviewer ?? `平板${this.device}`);
      revalidateSignatures(exhibit, this.discrepancies);
      // 复核决定本身也要同步给其他平板
      this.enqueue({
        type: 'upsert',
        recordId: exhibitId,
        fields: { [key]: merged } as Partial<Record<FieldKey, FieldVersion>>
      });
      this.log(`${exhibit.code} ${key} 冲突复核完成，选定值合并为 v${merged.version}`, 'success');
      this.persist();
    },

    enqueue(partial: Omit<QueueOp, 'opId' | 'device' | 'at' | 'attempts'>) {
      this.queue.push({
        opId: this.nextId('op'),
        device: this.device,
        at: Date.now(),
        attempts: 0,
        ...partial
      });
    },

    /**
     * 网络恢复：本机队列 + 其他平板到达的 inbox 一起合并。
     * 失败项原样保留在 queue（含原因），成功项出队；重试仍走同一套版本与门禁校验。
     */
    mergeNow() {
      const all = [...this.queue, ...this.inbox];
      if (all.length === 0) {
        this.log('没有待合并操作', 'info');
        return;
      }
      const failNow = failureInject;
      failureInject = null;
      const guarded = all.map((op) => {
        const injected = failNow?.(op);
        if (injected) {
          op.attempts += 1;
          op.lastError = injected;
        }
        return { op, blocked: injected };
      });
      const candidates = guarded.filter((item) => !item.blocked).map((item) => item.op);
      const injectedFailures = guarded.filter((item) => item.blocked).map((item) => item.op);

      const { report, consumedIds } = processQueue(
        { exhibits: this.exhibits, discrepancies: this.discrepancies },
        candidates
      );

      const consumed = new Set(consumedIds);
      this.queue = this.queue.filter((op) => !consumed.has(op.opId));
      this.inbox = [];
      // 注入失败 + 领域失败都保留在重试队列（不改变其原始内容）
      for (const op of [...injectedFailures, ...report.failed]) {
        if (!this.queue.some((item) => item.opId === op.opId)) this.queue.push(op);
      }
      this.lastReport = report;
      for (const conflict of report.conflicts) {
        this.log(`冲突双版保留：${conflict.code} ${conflict.field}`, 'conflict');
      }
      for (const sig of report.staleSignatures) {
        this.log(`签字失效待复核：${sig.role} / ${sig.signer} —— ${sig.invalidateReason}`, 'error');
      }
      for (const failed of report.failed) {
        this.log(`合并失败保留原操作（第 ${failed.attempts} 次）：${failed.opId} ${failed.type} —— ${failed.lastError}`, 'error');
      }
      if (report.applied > 0) this.log(`合并完成：应用 ${report.applied} 项，失败 ${report.failed.length + injectedFailures.length} 项，冲突 ${report.conflicts.length} 项`, 'success');
      this.persist();
    },

    retryFailed() {
      if (!this.queue.some((op) => op.attempts > 0)) return;
      this.mergeNow();
    },

    clearQueue() {
      this.queue = [];
      this.inbox = [];
      this.persist();
    },

    resetAll() {
      localStorage.removeItem(STORAGE_KEY);
      Object.assign(this.$state, seed());
      this.persist();
    },

    /* ---- 多平板场景模拟：往 inbox 投递“其他平板”的离线操作 ---- */

    /** 另一台平板对同一记录、基于旧版本改了读数 -> 合并时冲突双版保留 */
    simulateRemoteConflict(exhibitId: string, remote = 'B') {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      // 远端基于 temperature 的 v1 分叉（模拟其断网期间本机已改过）
      const baseVersion = exhibit.fields.temperature.version;
      const localValue = exhibit.fields.temperature.value;
      const remoteValue = localValue + 3;
      const incoming: FieldVersion = { value: remoteValue, version: baseVersion + 1, base: baseVersion, origin: remote };
      // 让本地版本先抬高一版，形成分叉：本地 v(n+1) 也基于 v(n)
      const localNext: FieldVersion = { value: localValue - 2, version: baseVersion + 1, base: baseVersion, origin: this.device };
      exhibit.fields.temperature = localNext;
      revalidateSignatures(exhibit, this.discrepancies);
      this.inbox.push({
        opId: this.nextId('op-remote'),
        type: 'upsert',
        device: remote,
        at: Date.now(),
        attempts: 0,
        recordId: exhibitId,
        fields: { temperature: incoming }
      });
      this.log(`【模拟】平板${remote} 断网期间也改了 ${exhibit.code} 温度，等待联网合并`);
      this.persist();
    },

    /** 另一台平板已确认某差异，本机重试解决时不得覆盖其确认 */
    simulateRemoteResolve(discrepancyId: string, remote = 'B') {
      this.inbox.push({
        opId: this.nextId('op-remote'),
        type: 'resolve',
        device: remote,
        at: Date.now(),
        attempts: 0,
        discrepancyId,
        recordId: this.discrepancies.find((d) => d.id === discrepancyId)?.exhibitId,
        resolvedBy: `平板${remote}(他人)`,
        note: '现场复检合格'
      });
      this.log(`【模拟】平板${remote} 已确认差异 ${discrepancyId}，其确认将先于本机重试到达`);
      this.persist();
    },

    /** 远端带有效签字的推进操作，供演示正常合并路径 */
    simulateRemoteSign(exhibitId: string, role: Role, remote = 'B') {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      const openIds = this.discrepancies.filter((d) => d.exhibitId === exhibitId && d.status === 'open').map((d) => d.id);
      const sig: Signature = {
        id: this.nextId('sig-remote'),
        role,
        signer: `${role}(平板${remote})`,
        device: remote,
        at: Date.now(),
        snapshot: snapshotOf(exhibit, this.discrepancies),
        discrepancySnapshot: openIds,
        fingerprint: fingerprintOf(exhibit, openIds),
        valid: true
      };
      this.inbox.push({ opId: this.nextId('op-remote'), type: 'sign', device: remote, at: Date.now(), attempts: 0, recordId: exhibitId, signature: sig });
      this.log(`【模拟】平板${remote} 的${role}签字已到达收件箱`);
      this.persist();
    }
  }
});
