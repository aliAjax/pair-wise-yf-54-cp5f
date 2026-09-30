/**
 * 多平板离线签字 / 联网合并的领域规则（纯函数，无 Vue 依赖，便于单测）
 *
 * 合并键：记录编号 recordId + 字段版本 FieldVersion { value, version, base, origin }
 * - version：单调递增的字段版本号，每次本地改动 +1
 * - base：该版本所基于的上游版本；三方一致直接覆盖，分叉则冲突双版保留
 * - 签名对读数与未解决差异做快照；任一字段版本变化或差异被处理，指纹即变 -> 原签字失效
 */

export type FieldKey = 'temperature' | 'humidity' | 'light';
export const FIELD_KEYS: FieldKey[] = ['temperature', 'humidity', 'light'];
export const FIELD_META: Record<FieldKey, { label: string; unit: string }> = {
  temperature: { label: '温度', unit: '℃' },
  humidity: { label: '湿度', unit: '%' },
  light: { label: '照度', unit: 'lux' }
};

export type Stage = 'arrival' | 'install' | 'return';
export const STAGE_LABEL: Record<Stage, string> = {
  arrival: '到场点交',
  install: '布展核验',
  return: '闭展归还'
};
export const STAGE_ORDER: Stage[] = ['arrival', 'install', 'return'];

export type Role = '保管员' | '借展方' | '布展负责人';
export const ROLES: Role[] = ['保管员', '借展方', '布展负责人'];

/** 字段的一个版本：读数 + 版本号 + 基于哪个上游版本改的 + 来源平板 */
export interface FieldVersion {
  value: number;
  version: number;
  base: number;
  origin: string;
  /** 复核人裁定的版本：同步到其他平板时权威快进，并清掉该项的待复核变体 */
  reviewed?: boolean;
}

export interface Signature {
  id: string;
  role: Role;
  signer: string;
  device: string;
  at: number;
  /** 签字时读数各字段的版本号 */
  snapshot: Record<FieldKey, number>;
  /** 签字时未解决差异的编号集合（排序后入指纹） */
  discrepancySnapshot: string[];
  /** 快照指纹；与当前状态不一致即失效 */
  fingerprint: string;
  valid: boolean;
  /** 失效/阻断原因，供界面“复核原因”展示 */
  invalidateReason?: string;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  fields: Record<FieldKey, FieldVersion>;
  signatures: Signature[];
  /** 冲突读数：字段 -> 两个（或多个）来源版本，等待复核选定，不覆盖任一方 */
  pendingVariants: Partial<Record<FieldKey, FieldVersion[]>>;
  reviewReasons: string[];
  updatedAt: number;
}

export type DiscrepancyStatus = 'open' | 'resolved';
export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  status: DiscrepancyStatus;
  /** 差异自身的版本，处理意见也是一种改动 */
  version: number;
  origin: string;
  resolvedBy?: string;
  resolvedAt?: number;
  note?: string;
}

export type OpType = 'upsert' | 'sign' | 'resolve' | 'advance';

export interface QueueOp {
  opId: string;
  type: OpType;
  device: string;
  at: number;
  /** 处理失败后的重试次数；失败操作原样保留在队首 */
  attempts: number;
  lastError?: string;
  recordId?: string;
  fields?: Partial<Record<FieldKey, FieldVersion>>;
  stage?: Stage;
  signature?: Signature;
  discrepancyId?: string;
  resolvedBy?: string;
  note?: string;
  /** 标记这是一条“新增差异”操作而非“确认解决” */
  declareNew?: boolean;
  /** 新增差异时携带的完整内容 */
  discrepancy?: { id: string; exhibitId: string; title: string; severity: 'minor' | 'major' };
}

export interface MergeConflict {
  exhibitId: string;
  code: string;
  field: FieldKey;
  kept: FieldVersion;
  incoming: FieldVersion;
}

export interface MergeReport {
  applied: number;
  /** 合并失败（含被门禁拒绝）的操作，保留在重试队列中 */
  failed: QueueOp[];
  conflicts: MergeConflict[];
  staleSignatures: Signature[];
  notes: string[];
}

export function fingerprintOf(exhibit: Pick<Exhibit, 'fields'>, unresolvedIds: string[]): string {
  const readings = FIELD_KEYS.map((key) => `${key}@${exhibit.fields[key].version}`).join('|');
  return `${readings}#D:${[...unresolvedIds].sort().join(',')}`;
}

export function snapshotOf(exhibit: Exhibit, discrepancies: Discrepancy[]): Signature['snapshot'] {
  return {
    temperature: exhibit.fields.temperature.version,
    humidity: exhibit.fields.humidity.version,
    light: exhibit.fields.light.version
  };
}

export function unresolvedFor(exhibitId: string, discrepancies: Discrepancy[]): Discrepancy[] {
  return discrepancies.filter((item) => item.exhibitId === exhibitId && item.status === 'open');
}

/** 依据当前读数版本与未解决差异，重新判定每条签字是否仍然有效 */
export function revalidateSignatures(exhibit: Exhibit, discrepancies: Discrepancy[]): void {
  const openIds = unresolvedFor(exhibit.id, discrepancies).map((item) => item.id);
  for (const sig of exhibit.signatures) {
    const reasons: string[] = [];
    for (const key of FIELD_KEYS) {
      if (sig.snapshot[key] !== exhibit.fields[key].version) {
        reasons.push(
          `${FIELD_META[key].label}读数已从 v${sig.snapshot[key]} 变更为 v${exhibit.fields[key].version}`
        );
      }
    }
    const nowIds = openIds.sort();
    const before = [...sig.discrepancySnapshot].sort();
    if (nowIds.join(',') !== before.join(',')) {
      const resolvedAway = before.filter((id) => !nowIds.includes(id));
      const added = nowIds.filter((id) => !before.includes(id));
      if (resolvedAway.length) reasons.push(`差异 ${resolvedAway.join('、')} 在签字后被处理`);
      if (added.length) reasons.push(`签字后新增未解决差异 ${added.join('、')}`);
    }
    sig.valid = reasons.length === 0;
    sig.invalidateReason = sig.valid ? undefined : reasons.join('；');
  }
}

export function latestValidSignatures(exhibit: Exhibit): Signature[] {
  return exhibit.signatures.filter((sig) => sig.valid);
}

/**
 * 推进门禁：复核完成前不能推进。
 * - 存在冲突读数待复核
 * - 存在未解决差异
 * - 任一签字已失效（读数/差异版本变化）
 * - 保管员与借展方未完成有效签字
 */
export function gateReason(exhibit: Exhibit, discrepancies: Discrepancy[]): string | null {
  const pendingFields = Object.keys(exhibit.pendingVariants).filter(
    (key) => (exhibit.pendingVariants as Record<string, FieldVersion[]>)[key]?.length
  );
  if (pendingFields.length) return `冲突读数待复核：${pendingFields.map((key) => FIELD_META[key as FieldKey].label).join('、')}`;
  const open = unresolvedFor(exhibit.id, discrepancies);
  if (open.length) return `未解决差异 ${open.length} 项（${open.map((item) => item.id).join('、')}）`;
  const invalid = exhibit.signatures.filter((sig) => !sig.valid);
  if (invalid.length) return `签字已失效：${invalid.map((sig) => `${sig.role}(${sig.invalidateReason ?? '版本变化'})`).join('；')}`;
  const roles = new Set(latestValidSignatures(exhibit).map((sig) => sig.role));
  const missing = (['保管员', '借展方'] as Role[]).filter((role) => !roles.has(role));
  if (missing.length) return `缺少有效签字：${missing.join('、')}`;
  return null;
}

/**
 * 合并单个字段（按记录编号已定位到同一展品）。
 * 规则：
 *  - 同一版本（重复处理，仍算一项）-> 只补来源，不产生新读数
 *  - incoming.base === 当前 version（快进）-> 直接采用
 *  - 分叉但读数相同 -> 视为重复，仅登记来源
 *  - 分叉且读数不同 -> 两版都保留、标明来源，进入待复核，不覆盖任一方
 * 返回是否发生冲突。
 */
export function mergeField(
  exhibit: Exhibit,
  key: FieldKey,
  incoming: FieldVersion
): MergeConflict | null {
  const local = exhibit.fields[key];

  if (incoming.version === local.version) {
    // 同一版本号：值相同即重复（幂等）；值不同则是同父分叉 -> 同样保留两版
    if (incoming.value === local.value) return null;
  } else if (incoming.base === local.version || incoming.reviewed) {
    // 严格线性：incoming 直接基于本地当前版本 -> 快进采用；
    // 或这是复核裁定版本 -> 权威快进，同时关闭本项待复核变体
    exhibit.fields[key] = { ...incoming };
    if (incoming.reviewed) exhibit.pendingVariants[key] = [];
    return null;
  }

  // 同值或已被上游以更高版本同值合并：重复处理仍算一项，不制造冲突
  if (incoming.value === local.value) {
    return null;
  }

  // 真正冲突：双版保留；若该版本已在变体中（重试/重复投递）则仍算一项
  const variants = exhibit.pendingVariants[key] ?? [];
  if (variants.some((v) => v.version === incoming.version && v.origin === incoming.origin && v.value === incoming.value)) {
    return null;
  }
  variants.push({ ...incoming });
  exhibit.pendingVariants[key] = variants;
  exhibit.reviewReasons.push(
    `${FIELD_META[key].label}读数冲突：本机 ${local.value}（v${local.version} @${local.origin}） vs 平板${incoming.origin} ${incoming.value}（v${incoming.version}），两版均已保留`
  );
  return {
    exhibitId: exhibit.id,
    code: exhibit.code,
    field: key,
    kept: { ...local },
    incoming: { ...incoming }
  };
}

interface MergeState {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
}

/**
 * 处理合并队列。成功的操作出队；失败的操作原样保留并记录原因，
 * 调用方据返回的 failedId 保留重试队列。重试时所有写入仍走同一套
 * base/version 比较与门禁，因此不会覆盖他人已确认的数据。
 */
export function processQueue(state: MergeState, queue: QueueOp[]): { report: MergeReport; consumedIds: string[] } {
  const report: MergeReport = { applied: 0, failed: [], conflicts: [], staleSignatures: [], notes: [] };
  const consumedIds: string[] = [];

  for (const op of queue) {
    try {
      if (op.type === 'upsert') {
        let exhibit = state.exhibits.find((item) => item.id === op.recordId);
        if (!exhibit) {
          // 该平板上新建的展品（其他平板尚未见过）
          if (!op.fields || !op.recordId) throw new Error('缺少记录编号或读数');
          exhibit = {
            id: op.recordId,
            code: op.recordId.toUpperCase(),
            name: `来自平板${op.device} 的展品`,
            lender: '待补充',
            hall: '待分配',
            stage: 'arrival',
            fields: {
              temperature: op.fields.temperature ?? { value: 20, version: 1, base: 0, origin: op.device },
              humidity: op.fields.humidity ?? { value: 50, version: 1, base: 0, origin: op.device },
              light: op.fields.light ?? { value: 150, version: 1, base: 0, origin: op.device }
            },
            signatures: [],
            pendingVariants: {},
            reviewReasons: [],
            updatedAt: op.at
          };
          state.exhibits.unshift(exhibit);
          report.notes.push(`新记录 ${exhibit.code} 由平板${op.device} 合并入库`);
        } else {
          for (const key of FIELD_KEYS) {
            const incoming = op.fields?.[key];
            if (incoming) {
              const conflict = mergeField(exhibit, key, incoming);
              if (conflict) report.conflicts.push(conflict);
            }
          }
          exhibit.updatedAt = Math.max(exhibit.updatedAt, op.at);
        }
        revalidateSignatures(exhibit, state.discrepancies);
      } else if (op.type === 'sign') {
        const sig = op.signature;
        const exhibit = state.exhibits.find((item) => item.id === op.recordId);
        if (!sig || !exhibit) throw new Error('签字操作缺少记录或签名内容');
        // 重复处理仍算一项：同 opId 或同角色同指纹只保留一项
        const duplicated =
          exhibit.signatures.some((existing) => existing.role === sig.role && existing.fingerprint === sig.fingerprint);
        if (!duplicated) exhibit.signatures.push({ ...sig });
        revalidateSignatures(exhibit, state.discrepancies);
        const stored = duplicated
          ? exhibit.signatures.find((existing) => existing.role === sig.role && existing.fingerprint === sig.fingerprint)!
          : exhibit.signatures.find((item) => item.id === sig.id);
        if (stored && !stored.valid) {
          report.staleSignatures.push(stored);
          // 失效签字不丢弃（作为痕迹保留），但该操作视为被门禁拒绝 -> 留在重试队列
          throw new Error(`签字时的读数/差异版本已变化：${stored.invalidateReason}`);
        }
      } else if (op.type === 'resolve') {
        if (op.declareNew) {
          // 新增差异：重复处理仍算一项（已存在则幂等）
          const existing = state.discrepancies.find((item) => item.id === op.discrepancyId);
          if (!existing && op.discrepancy) {
            state.discrepancies.push({
              id: op.discrepancy.id,
              exhibitId: op.discrepancy.exhibitId,
              title: op.discrepancy.title,
              severity: op.discrepancy.severity,
              status: 'open',
              version: 1,
              origin: op.device
            });
            state.exhibits
              .filter((item) => item.id === op.discrepancy!.exhibitId)
              .forEach((item) => revalidateSignatures(item, state.discrepancies));
          }
        } else {
          const disc = state.discrepancies.find((item) => item.id === op.discrepancyId);
          if (!disc) throw new Error(`差异 ${op.discrepancyId} 不存在`);
        if (disc.status === 'resolved') {
          // 他人已确认：幂等成功，绝不覆盖确认人与意见
          report.notes.push(`差异 ${disc.id} 已由 ${disc.resolvedBy} 确认，跳过`);
        } else {
          disc.status = 'resolved';
          disc.version += 1;
          disc.resolvedBy = op.resolvedBy ?? `平板${op.device}`;
          disc.resolvedAt = op.at;
          disc.note = op.note;
        }
        state.exhibits
          .filter((item) => item.id === disc.exhibitId)
          .forEach((item) => revalidateSignatures(item, state.discrepancies));
        }
      } else if (op.type === 'advance') {
        const exhibit = state.exhibits.find((item) => item.id === op.recordId);
        if (!exhibit) throw new Error('推进操作缺少记录');
        const reason = gateReason(exhibit, state.discrepancies);
        if (reason) throw new Error(`复核未完成，禁止推进：${reason}`);
        const idx = STAGE_ORDER.indexOf(exhibit.stage);
        exhibit.stage = STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)];
        exhibit.updatedAt = op.at;
      }

      report.applied += 1;
      consumedIds.push(op.opId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      op.attempts += 1;
      op.lastError = message;
      report.failed.push(op);
      report.notes.push(`操作 ${op.opId}（${op.type}）合并失败保留重试：${message}`);
    }
  }

  return { report, consumedIds };
}

/** 复核人在两版冲突读数中选定一版（或给第三版），选定后冲突关闭、字段版本抬升 */
export function resolveVariant(
  exhibit: Exhibit,
  key: FieldKey,
  chosen: FieldVersion,
  reviewer: string
): FieldVersion {
  const current = exhibit.fields[key];
  const merged: FieldVersion = {
    value: chosen.value,
    version: Math.max(current.version, chosen.version) + 1,
    base: Math.max(current.version, chosen.version),
    origin: `复核:${reviewer}`,
    reviewed: true
  };
  exhibit.fields[key] = merged;
  exhibit.pendingVariants[key] = [];
  exhibit.reviewReasons.push(
    `${FIELD_META[key].label}冲突已由 ${reviewer} 复核选定 ${chosen.value}（合并为 v${merged.version}）`
  );
  return merged;
}

export function readingText(v: FieldVersion, key: FieldKey): string {
  return `${v.value}${FIELD_META[key].unit} · v${v.version} · 平板${v.origin}`;
}

export function describeVariant(v: FieldVersion, key: FieldKey): string {
  return `${v.value}${FIELD_META[key].unit}（v${v.version}，平板${v.origin}）`;
}
