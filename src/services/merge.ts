import type { CheckStatus, Discrepancy, Exhibit, MergeResult, ReadingField, Signature, SourceId, StatusRecord } from '../stores/exhibition';

/** 签字时记录的读数快照是否与当前一致 */
export function readingsMatch(exhibit: Exhibit, readings: Signature['readings']): boolean {
  return readings.temperature === exhibit.environment.temperature.value
    && readings.humidity === exhibit.environment.humidity.value
    && readings.light === exhibit.environment.light.value;
}

/** 任一读数 / 条件 / 差异版本变更都会让原签字失效 */
export function invalidateSignatures(exhibit: Exhibit, reason: string): void {
  for (const sig of exhibit.signatures) {
    if (sig.valid) {
      sig.valid = false;
      sig.invalidReason = reason;
    }
  }
}

/** 复核后：读数与未解决差异版本仍吻合的签字自动恢复有效，其余需重新签字 */
export function revalidateSignatures(exhibit: Exhibit): void {
  for (const sig of exhibit.signatures) {
    if (readingsMatch(exhibit, sig.readings) && sig.discrepancyVersion === exhibit.discrepancyVersion) {
      sig.valid = true;
      sig.invalidReason = undefined;
    } else {
      sig.valid = false;
      sig.invalidReason = '读数或未解决差异版本已变更，需复核后重新签字';
    }
  }
}

/** 读数合并：按字段版本比对，冲突时保留两版并标明来源 */
export function mergeReading(
  exhibit: Exhibit,
  field: ReadingField,
  value: number,
  baseVersion: number,
  source: SourceId,
  at: number
): MergeResult {
  const current = exhibit.environment[field];
  // 重试不能覆盖他人已确认的数据
  if (current.confirmed && source !== current.source) {
    return { status: 'failed', reason: `读数「${fieldLabel(field)}」已由 ${current.source} 确认，重试不可覆盖` };
  }
  if (baseVersion >= current.version) {
    // 作废上一版读数记录，避免旧版被误算为冲突版本
    for (const record of exhibit.readings) {
      if (record.field === field && record.version === current.version && !record.superseded) {
        record.superseded = true;
      }
    }
    current.value = value;
    current.version += 1;
    current.source = source;
    current.at = at;
    current.confirmed = false;
    exhibit.readings.push({ field, value, version: current.version, source, at, confirmed: false, superseded: false });
    return { status: 'merged' };
  }
  // 版本冲突：保留两版并标明来源
  const incomingVersion = baseVersion + 1;
  exhibit.readings.push({ field, value, version: incomingVersion, source, at, confirmed: false, superseded: false });
  const reason = `读数「${fieldLabel(field)}」版本冲突：${source} 提交 ${value}${unit(field)}（v${incomingVersion}），当前为 ${current.source} 的 ${current.value}${unit(field)}（v${current.version}），需复核确认`;
  invalidateSignatures(exhibit, `读数「${fieldLabel(field)}」冲突变更，原签字失效，需复核`);
  return { status: 'conflict', reason };
}

/** 条件合并：与读数同一套字段版本规则，保留历史供复核 */
export function mergeStatus(
  exhibit: Exhibit,
  value: CheckStatus,
  baseVersion: number,
  source: SourceId,
  at: number
): MergeResult {
  const current = exhibit.status;
  if (current.confirmed && source !== current.source) {
    return { status: 'failed', reason: `条件已由 ${current.source} 确认，重试不可覆盖` };
  }
  if (baseVersion >= current.version) {
    for (const record of exhibit.statusHistory) {
      if (record.version === current.version && !record.superseded) record.superseded = true;
    }
    current.value = value;
    current.version += 1;
    current.source = source;
    current.at = at;
    current.confirmed = false;
    exhibit.statusHistory.push({ value, version: current.version, source, at, confirmed: false, superseded: false });
    return { status: 'merged' };
  }
  const incomingVersion = baseVersion + 1;
  exhibit.statusHistory.push({ value, version: incomingVersion, source, at, confirmed: false, superseded: false });
  const reason = `条件版本冲突：${source} 提交 ${value}（v${incomingVersion}），当前为 ${current.source} 的 ${current.value}（v${current.version}），需复核确认`;
  invalidateSignatures(exhibit, '条件冲突变更，原签字失效，需复核');
  return { status: 'conflict', reason };
}

/** 签字合并：记下读数快照与未解决差异版本 */
export function mergeSign(
  exhibit: Exhibit,
  role: string,
  source: SourceId,
  at: number,
  readings: Signature['readings'],
  discrepancyVersion: number
): MergeResult {
  // 幂等：同一来源同一角色的有效签字不重复处理
  const existing = exhibit.signatures.find((s) => s.role === role && s.source === source && s.valid);
  if (existing) return { status: 'duplicate' };
  exhibit.signatures.push({ role, source, at, readings, discrepancyVersion, valid: true });
  return { status: 'merged' };
}

/** 差异处理合并：解决差异会提升未解决差异版本，进而让原签字失效 */
export function mergeResolveDiscrepancy(discrepancy: Discrepancy, exhibit: Exhibit, source: SourceId): MergeResult {
  if (discrepancy.resolved) return { status: 'duplicate' };
  discrepancy.resolved = true;
  discrepancy.version += 1;
  exhibit.discrepancyVersion += 1;
  invalidateSignatures(exhibit, '未解决差异版本变更，原签字失效，需复核');
  return { status: 'merged' };
}

export function fieldLabel(field: ReadingField): string {
  return field === 'temperature' ? '温度' : field === 'humidity' ? '湿度' : '照度';
}

export function unit(field: ReadingField): string {
  return field === 'temperature' ? '℃' : field === 'humidity' ? '%' : ' lux';
}
