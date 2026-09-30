import { defineStore } from 'pinia';
import {
  mergeReading,
  mergeStatus,
  mergeSign,
  mergeResolveDiscrepancy,
  revalidateSignatures,
  fieldLabel,
  unit
} from '../services/merge';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type SourceId = string;
export type ReadingField = 'temperature' | 'humidity' | 'light';

/** 带版本的值：每个字段独立版本号，记录来源与是否已确认锁定 */
export interface Versioned<T> {
  value: T;
  version: number;
  source: SourceId;
  at: number;
  confirmed: boolean;
}

/** 读数记录：冲突时保留多版，标明来源 */
export interface ReadingRecord {
  field: ReadingField;
  value: number;
  version: number;
  source: SourceId;
  at: number;
  confirmed: boolean;
  superseded: boolean;
}

/** 条件记录：冲突时保留多版，标明来源 */
export interface StatusRecord {
  value: CheckStatus;
  version: number;
  source: SourceId;
  at: number;
  confirmed: boolean;
  superseded: boolean;
}

/** 签字：记下读数快照与未解决差异版本，任一改动即失效 */
export interface Signature {
  role: string;
  source: SourceId;
  at: number;
  readings: { temperature: number; humidity: number; light: number };
  discrepancyVersion: number;
  valid: boolean;
  invalidReason?: string;
}

export type OpType = 'setCondition' | 'setReading' | 'sign' | 'resolveDiscrepancy' | 'addExhibit';
export type OpStatus = 'pending' | 'merged' | 'conflict' | 'failed' | 'duplicate';

/** 离线操作队列项：保留原操作与重试次数 */
export interface Operation {
  opId: string;
  type: OpType;
  recordId: string;
  field?: ReadingField;
  value?: unknown;
  baseVersion: number;
  source: SourceId;
  createdAt: number;
  retries: number;
  status: OpStatus;
  reason?: string;
  // sign 专用：签字时的读数快照与未解决差异版本
  readings?: Signature['readings'];
  discrepancyVersion?: number;
  // resolveDiscrepancy 专用
  discrepancyId?: string;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: Versioned<CheckStatus>;
  statusHistory: StatusRecord[];
  environment: {
    temperature: Versioned<number>;
    humidity: Versioned<number>;
    light: Versioned<number>;
  };
  readings: ReadingRecord[];
  signatures: Signature[];
  discrepancyVersion: number;
}

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
  version: number;
}

export interface MergeResult {
  status: 'merged' | 'conflict' | 'failed' | 'duplicate';
  reason?: string;
}

interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  operations: Operation[];
  deviceId: SourceId;
  knownTablets: SourceId[];
}

const STORAGE_KEY = 'yf54-exhibition-state';
const now = Date.now;

function makeEnvironment(temp: number, humidity: number, light: number, source: SourceId, at: number) {
  return {
    temperature: { value: temp, version: 1, source, at, confirmed: false },
    humidity: { value: humidity, version: 1, source, at, confirmed: false },
    light: { value: light, version: 1, source, at, confirmed: false }
  };
}

function makeReadings(temp: number, humidity: number, light: number, source: SourceId, at: number): ReadingRecord[] {
  return [
    { field: 'temperature', value: temp, version: 1, source, at, confirmed: false, superseded: false },
    { field: 'humidity', value: humidity, version: 1, source, at, confirmed: false, superseded: false },
    { field: 'light', value: light, version: 1, source, at, confirmed: false, superseded: false }
  ];
}

function makeSignatures(roles: string[], temp: number, humidity: number, light: number, source: SourceId, at: number): Signature[] {
  return roles.map((role) => ({
    role,
    source,
    at,
    readings: { temperature: temp, humidity, light },
    discrepancyVersion: 1,
    valid: true
  }));
}

function buildSeed(): State {
  const at = now();
  const source = '初始';
  const exhibits: Exhibit[] = Array.from({ length: 24 }, (_, index) => {
    const temp = 20 + (index % 3);
    const humidity = 48 + (index % 8);
    const light = 120 + index * 3;
    const roles = index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [];
    return {
      id: `ex-${index + 1}`,
      code: `M${String(index + 1).padStart(3, '0')}`,
      name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
      lender: index % 2 ? '西北博物馆' : '私人借展方',
      hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
      stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
      status: { value: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending', version: 1, source, at, confirmed: false },
      statusHistory: [{ value: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending', version: 1, source, at, confirmed: false, superseded: false }],
      environment: makeEnvironment(temp, humidity, light, source, at),
      readings: makeReadings(temp, humidity, light, source, at),
      signatures: makeSignatures(roles, temp, humidity, light, source, at),
      discrepancyVersion: 1
    };
  });

  const discrepancies: Discrepancy[] = [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false, version: 1 },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false, version: 1 }
  ];

  // 预置两条其他平板的离线操作，联网同步后立即出现读数冲突与差异版本变更
  const operations: Operation[] = [
    {
      opId: 'op-seed-1',
      type: 'setReading',
      recordId: 'ex-1',
      field: 'temperature',
      value: 23.5,
      baseVersion: 1,
      source: '平板-B2',
      createdAt: at,
      retries: 0,
      status: 'pending'
    },
    {
      opId: 'op-seed-2',
      type: 'setReading',
      recordId: 'ex-1',
      field: 'temperature',
      value: 21.0,
      baseVersion: 1,
      source: '平板-C3',
      createdAt: at,
      retries: 0,
      status: 'pending'
    },
    {
      opId: 'op-seed-3',
      type: 'resolveDiscrepancy',
      recordId: 'ex-5',
      discrepancyId: 'd1',
      value: 'd1',
      baseVersion: 1,
      source: '平板-B2',
      createdAt: at,
      retries: 0,
      status: 'pending'
    }
  ];

  const deviceId = '平板-A1';
  return { exhibits, discrepancies, operations, deviceId, knownTablets: ['平板-A1', '平板-B2', '平板-C3'] };
}

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as State;
      if (parsed.deviceId && Array.isArray(parsed.operations) && parsed.exhibits?.length) return parsed;
    } catch {
      // 落盘数据损坏时回到初始种子
    }
  }
  return buildSeed();
}

/** 某展品当前的条件冲突（同一条件存在多个未确认且未作废的版本） */
function conflictedStatuses(exhibit: Exhibit): StatusRecord[] {
  return exhibit.statusHistory.filter((r) => !r.confirmed && !r.superseded);
}

/** 某展品当前的读数冲突（同一字段存在多个未确认且未作废的版本） */
function conflictedReadings(exhibit: Exhibit): { field: ReadingField; records: ReadingRecord[] }[] {
  const fields: ReadingField[] = ['temperature', 'humidity', 'light'];
  const result: { field: ReadingField; records: ReadingRecord[] }[] = [];
  for (const field of fields) {
    const records = exhibit.readings.filter((r) => r.field === field && !r.confirmed && !r.superseded);
    if (records.length > 1) result.push({ field, records });
  }
  return result;
}

/** 某展品的复核原因（读数冲突 + 条件冲突 + 失效签字） */
function reviewReasonsFor(exhibit: Exhibit): string[] {
  const reasons: string[] = [];
  for (const { field, records } of conflictedReadings(exhibit)) {
    reasons.push(
      `读数「${fieldLabel(field)}」存在 ${records.length} 个冲突版本：${records
        .map((r) => `${r.source} ${r.value}${unit(field)}（v${r.version}）`)
        .join(' / ')}，需复核确认`
    );
  }
  const statuses = conflictedStatuses(exhibit);
  if (statuses.length > 1) {
    reasons.push(
      `条件存在 ${statuses.length} 个冲突版本：${statuses.map((r) => `${r.source} ${r.value}（v${r.version}）`).join(' / ')}，需复核确认`
    );
  }
  for (const sig of exhibit.signatures) {
    if (!sig.valid) reasons.push(`${sig.role} 签字已失效：${sig.invalidReason ?? '需复核'}`);
  }
  return reasons;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    /** 等待处理项：待合并 / 冲突 / 失败重试的操作 */
    waitingOps: (state) =>
      state.operations.filter((op) => op.status === 'pending' || op.status === 'conflict' || op.status === 'failed'),
    /** 等待复核的展品 */
    reviewExhibits: (state) => state.exhibits.filter((ex) => reviewReasonsFor(ex).length > 0),
    reviewCount(): number {
      return this.reviewExhibits.length;
    },
    queued(): number {
      return this.waitingOps.length;
    },
    reviewReasonsFor: (state) => (exhibitId: string) => {
      const exhibit = state.exhibits.find((item) => item.id === exhibitId);
      return exhibit ? reviewReasonsFor(exhibit) : [];
    },
    conflictedReadings: (state) => (exhibitId: string) => {
      const exhibit = state.exhibits.find((item) => item.id === exhibitId);
      return exhibit ? conflictedReadings(exhibit) : [];
    },
    conflictedStatuses: (state) => (exhibitId: string) => {
      const exhibit = state.exhibits.find((item) => item.id === exhibitId);
      return exhibit ? conflictedStatuses(exhibit) : [];
    }
  },
  actions: {
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state));
    },
    /** 入队一条离线操作，记录来源平板与所基于的字段版本 */
    enqueue(op: Omit<Operation, 'opId' | 'createdAt' | 'retries' | 'status'>) {
      this.operations.push({
        ...op,
        opId: `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: Date.now(),
        retries: 0,
        status: 'pending'
      });
      this.persist();
    },
    setCondition(id: string, status: CheckStatus) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      this.enqueue({
        type: 'setCondition',
        recordId: id,
        value: status,
        baseVersion: exhibit.status.version,
        source: this.deviceId
      });
    },
    setReading(id: string, field: ReadingField, value: number) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      this.enqueue({
        type: 'setReading',
        recordId: id,
        field,
        value,
        baseVersion: exhibit.environment[field].version,
        source: this.deviceId
      });
    },
    sign(id: string, role: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      // 已有本设备有效签字则不重复入队
      if (exhibit.signatures.some((s) => s.role === role && s.source === this.deviceId && s.valid)) return;
      this.enqueue({
        type: 'sign',
        recordId: id,
        value: role,
        baseVersion: 0,
        source: this.deviceId,
        readings: {
          temperature: exhibit.environment.temperature.value,
          humidity: exhibit.environment.humidity.value,
          light: exhibit.environment.light.value
        },
        discrepancyVersion: exhibit.discrepancyVersion
      });
    },
    resolveDiscrepancy(id: string) {
      const discrepancy = this.discrepancies.find((item) => item.id === id);
      if (!discrepancy || discrepancy.resolved) return;
      this.enqueue({
        type: 'resolveDiscrepancy',
        recordId: discrepancy.exhibitId,
        discrepancyId: id,
        value: id,
        baseVersion: discrepancy.version,
        source: this.deviceId
      });
    },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      const exhibit: Exhibit = {
        id: `ex-${Date.now()}`,
        ...payload,
        stage: 'arrival',
        status: { value: 'pending', version: 1, source: this.deviceId, at: Date.now(), confirmed: false },
        statusHistory: [{ value: 'pending', version: 1, source: this.deviceId, at: Date.now(), confirmed: false, superseded: false }],
        environment: makeEnvironment(20, 50, 150, this.deviceId, Date.now()),
        readings: makeReadings(20, 50, 150, this.deviceId, Date.now()),
        signatures: [],
        discrepancyVersion: 1
      };
      this.enqueue({ type: 'addExhibit', recordId: exhibit.id, value: exhibit, baseVersion: 0, source: this.deviceId });
    },
    /** 推进阶段：复核未完成、缺少借展方有效签字或存在未解决差异时不能推进 */
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      if (reviewReasonsFor(exhibit).length > 0) return;
      if (!exhibit.signatures.some((s) => s.role === '借展方' && s.valid)) return;
      if (this.discrepancies.some((d) => d.exhibitId === id && !d.resolved)) return;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.persist();
    },
    /** 应用单条操作到合并引擎 */
    applyOp(op: Operation): MergeResult {
      const exhibit = this.exhibits.find((item) => item.id === op.recordId);
      if (!exhibit) return { status: 'failed', reason: '记录不存在' };
      switch (op.type) {
        case 'setReading':
          return mergeReading(exhibit, op.field as ReadingField, op.value as number, op.baseVersion, op.source, op.createdAt);
        case 'setCondition':
          return mergeStatus(exhibit, op.value as CheckStatus, op.baseVersion, op.source, op.createdAt);
        case 'sign':
          return mergeSign(
            exhibit,
            op.value as string,
            op.source,
            op.createdAt,
            op.readings as Signature['readings'],
            op.discrepancyVersion ?? 0
          );
        case 'resolveDiscrepancy': {
          const discrepancy = this.discrepancies.find((item) => item.id === op.discrepancyId);
          if (!discrepancy) return { status: 'failed', reason: '差异项不存在' };
          return mergeResolveDiscrepancy(discrepancy, exhibit, op.source);
        }
        case 'addExhibit': {
          const incoming = op.value as Exhibit;
          if (this.exhibits.some((item) => item.id === incoming.id)) return { status: 'duplicate' };
          this.exhibits.unshift(incoming);
          return { status: 'merged' };
        }
      }
    },
    /** 网络恢复后合并队列：同设备重复修改以最新为准，冲突/失败保留原操作进重试队列 */
    syncQueue() {
      // 同设备对同一记录同一字段的多次修改，以最新一次为准，其余作废（重复处理仍算一项）
      const latestByKey = new Map<string, Operation>();
      for (const op of this.operations) {
        if (op.status !== 'pending') continue;
        if (op.type !== 'setReading' && op.type !== 'setCondition') continue;
        const key = `${op.source}|${op.recordId}|${op.field ?? 'status'}`;
        const prev = latestByKey.get(key);
        if (!prev || op.createdAt > prev.createdAt) {
          if (prev) prev.status = 'duplicate';
          latestByKey.set(key, op);
        } else {
          op.status = 'duplicate';
        }
      }

      for (const op of this.operations) {
        if (op.status !== 'pending' && op.status !== 'failed') continue;
        const result = this.applyOp(op);
        op.retries += 1;
        if (result.status === 'merged' || result.status === 'duplicate') {
          op.status = result.status;
          op.reason = undefined;
        } else if (result.status === 'conflict') {
          op.status = 'conflict';
          op.reason = result.reason;
        } else {
          op.status = 'failed';
          op.reason = result.reason;
        }
      }
      this.persist();
    },
    /** 复核：确认冲突读数中的一版，锁定后重试不可覆盖 */
    confirmReading(exhibitId: string, field: ReadingField, value: number) {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      const current = exhibit.environment[field];
      current.value = value;
      current.version += 1;
      current.source = this.deviceId;
      current.at = Date.now();
      current.confirmed = true;
      for (const record of exhibit.readings) {
        if (record.field !== field) continue;
        if (!record.confirmed && !record.superseded && record.value === value) {
          record.confirmed = true;
        } else if (!record.confirmed) {
          record.superseded = true;
        }
      }
      revalidateSignatures(exhibit);
      this.persist();
    },
    /** 复核：确认冲突条件中的一版，锁定后重试不可覆盖 */
    confirmStatus(exhibitId: string, value: CheckStatus) {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      exhibit.status.value = value;
      exhibit.status.version += 1;
      exhibit.status.source = this.deviceId;
      exhibit.status.at = Date.now();
      exhibit.status.confirmed = true;
      for (const record of exhibit.statusHistory) {
        if (record.value === value && !record.confirmed && !record.superseded) {
          record.confirmed = true;
        } else if (!record.confirmed) {
          record.superseded = true;
        }
      }
      revalidateSignatures(exhibit);
      this.persist();
    },
    retryOp(opId: string) {
      const op = this.operations.find((item) => item.opId === opId);
      if (!op) return;
      op.status = 'pending';
      op.reason = undefined;
      this.syncQueue();
    },
    /** 切换到某台平板（模拟多设备） */
    switchTablet(id: string) {
      if (!this.knownTablets.includes(id)) this.knownTablets.push(id);
      this.deviceId = id;
      this.persist();
    },
    /** 新增一台平板并切换过去 */
    addTablet(name: string) {
      const id = name.trim() || `平板-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      this.switchTablet(id);
    }
  }
});
