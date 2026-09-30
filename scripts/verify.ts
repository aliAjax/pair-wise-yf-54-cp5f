/**
 * 领域规则端到端验证：node --import tsx scripts/verify.ts
 * 覆盖需求：断网签字快照、改动致签字失效、门禁、按记录编号+字段版本合并、
 * 冲突双版保留、重复幂等、失败保留原操作重试、重试不覆盖他人确认。
 */
import assert from 'node:assert';
import {
  FIELD_KEYS,
  fingerprintOf,
  gateReason,
  processQueue,
  revalidateSignatures,
  resolveVariant,
  snapshotOf,
  type Discrepancy,
  type Exhibit,
  type FieldVersion,
  type QueueOp
} from '../src/domain';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fv(value: number, version = 1, base = 0, origin = 'A'): FieldVersion {
  return { value, version, base, origin };
}
function makeExhibit(overrides: Partial<Exhibit> = {}): Exhibit {
  return {
    id: 'ex-1',
    code: 'M001',
    name: '青铜镜 1',
    lender: '西北博物馆',
    hall: 'A2',
    stage: 'arrival',
    fields: { temperature: fv(20, 1), humidity: fv(50, 1), light: fv(150, 1) },
    signatures: [],
    pendingVariants: {},
    reviewReasons: [],
    updatedAt: 0,
    ...overrides
  };
}
function openDisc(exhibitId = 'ex-1'): Discrepancy {
  return { id: 'd1', exhibitId, title: '封条不符', severity: 'major', status: 'open', version: 1, origin: 'A' };
}
function signOp(exhibit: Exhibit, discrepancies: Discrepancy[], device: string, role: QueueOp['type'] extends never ? never : '保管员' | '借展方' | '布展负责人'): QueueOp {
  const openIds = discrepancies.filter((d) => d.exhibitId === exhibit.id && d.status === 'open').map((d) => d.id);
  const signature = {
    id: `sig-${device}-${role}`,
    role,
    signer: role,
    device,
    at: 1000,
    snapshot: snapshotOf(exhibit, discrepancies),
    discrepancySnapshot: openIds,
    fingerprint: fingerprintOf(exhibit, openIds),
    valid: true
  };
  return { opId: `op-sig-${device}`, type: 'sign', device, at: 1000, attempts: 0, recordId: exhibit.id, signature };
}

console.log('1) 签字快照：读数或差异变化后原签字失效');
{
  const discrepancies = [openDisc()];
  const ex = makeExhibit();
  const op = signOp(ex, discrepancies, 'A', '保管员');
  processQueue({ exhibits: [ex], discrepancies }, [op]);
  assert.strictEqual(ex.signatures[0].valid, true);

  // 读数版本变化
  ex.fields.temperature = fv(23, 2, 1, 'B');
  revalidateSignatures(ex, discrepancies);
  check('温度读数 v1→v2 后保管员签字失效并给出原因', () => {
    assert.strictEqual(ex.signatures[0].valid, false);
    assert.ok(ex.signatures[0].invalidateReason!.includes('温度'));
  });

  // 差异被解决
  ex.fields.temperature = fv(20, 1, 0, 'A');
  discrepancies[0].status = 'resolved';
  discrepancies[0].resolvedBy = 'A';
  revalidateSignatures(ex, discrepancies);
  check('差异被处理后签字同样失效', () => {
    assert.ok(!ex.signatures[0].valid);
    assert.ok(ex.signatures[0].invalidateReason!.includes('差异 d1'));
  });
}

console.log('2) 复核完成前不能推进');
{
  const discrepancies: Discrepancy[] = [];
  const ex = makeExhibit();
  check('无签字不能推进', () => assert.ok(gateReason(ex, discrepancies)?.includes('缺少有效签字')));

  const opA = signOp(ex, discrepancies, 'A', '保管员');
  const opB = signOp(ex, discrepancies, 'B', '借展方');
  processQueue({ exhibits: [ex], discrepancies }, [opA, opB]);
  check('双方有效签字且无差异时门禁通过', () => assert.strictEqual(gateReason(ex, discrepancies), null));

  ex.pendingVariants.temperature = [fv(28, 2, 1, 'C')];
  check('存在冲突读数待复核时不能推进', () => assert.ok(gateReason(ex, discrepancies)?.includes('冲突读数待复核')));
  ex.pendingVariants.temperature = [];

  discrepancies.push(openDisc());
  check('存在未解决差异时不能推进', () => assert.ok(gateReason(ex, discrepancies)!.includes('未解决差异')));
}

console.log('3) 按记录编号 + 字段版本合并：快进 / 冲突双版保留 / 重复幂等');
{
  const ex = makeExhibit();
  const discrepancies: Discrepancy[] = [];

  // 线性快进：B 基于 v1 改成 v2
  const fast: QueueOp = {
    opId: 'op1', type: 'upsert', device: 'B', at: 2000, attempts: 0,
    recordId: 'ex-1', fields: { temperature: fv(22, 2, 1, 'B') }
  };
  let r = processQueue({ exhibits: [ex], discrepancies }, [fast]);
  check('基于当前版本的改动快进覆盖', () => {
    assert.strictEqual(ex.fields.temperature.value, 22);
    assert.strictEqual(ex.fields.temperature.version, 2);
    assert.strictEqual(r.report.conflicts.length, 0);
  });

  // 分叉：当前 v2，A 也基于 v1 提交另一读数（v2', value 不同）-> 冲突
  const divergent: QueueOp = {
    opId: 'op2', type: 'upsert', device: 'A', at: 3000, attempts: 0,
    recordId: 'ex-1', fields: { temperature: fv(18, 2, 1, 'A') }
  };
  r = processQueue({ exhibits: [ex], discrepancies }, [divergent]);
  check('分叉且读数不同：两版保留并标明来源，当前读数不被覆盖', () => {
    assert.strictEqual(ex.fields.temperature.value, 22, '本机/已合并值保留');
    assert.strictEqual(ex.pendingVariants.temperature?.length, 1);
    assert.strictEqual(ex.pendingVariants.temperature?.[0].value, 18);
    assert.strictEqual(ex.pendingVariants.temperature?.[0].origin, 'A');
    assert.strictEqual(r.report.conflicts.length, 1);
    assert.ok(ex.reviewReasons[0].includes('冲突'));
  });

  // 重复处理仍算一项：再次投递同一版本
  r = processQueue({ exhibits: [ex], discrepancies }, [{ ...divergent, opId: 'op2-retry' }]);
  check('同一版本重复合并不再追加变体（重复仍算一项）', () => {
    assert.strictEqual(ex.pendingVariants.temperature?.length, 1);
    assert.strictEqual(r.report.conflicts.length, 0);
  });

  // 复核选定：版本抬升，base 指向两版最大值，旧字失效可重新签
  const chosen = ex.pendingVariants.temperature![0];
  const merged = resolveVariant(ex, 'temperature', chosen, '复核员张');
  check('复核选定后冲突关闭且字段版本抬升', () => {
    assert.strictEqual(ex.fields.temperature.version, merged.version);
    assert.strictEqual(merged.version, 3);
    assert.strictEqual(ex.pendingVariants.temperature?.length, 0);
  });
}

console.log('4) 合并失败保留原操作；重试成功后出队');
{
  const ex = makeExhibit();
  const discrepancies: Discrepancy[] = [];
  const badAdvance: QueueOp = { opId: 'op-adv', type: 'advance', device: 'A', at: 1, attempts: 0, recordId: 'ex-1' };
  const r1 = processQueue({ exhibits: [ex], discrepancies }, [badAdvance]);
  check('门禁拒绝的推进操作失败并原样保留（含错误原因）', () => {
    assert.strictEqual(r1.consumedIds.length, 0);
    assert.strictEqual(r1.report.failed.length, 1);
    assert.strictEqual(r1.report.failed[0].opId, 'op-adv');
    assert.strictEqual(r1.report.failed[0].attempts, 1);
    assert.ok(r1.report.failed[0].lastError!.includes('复核未完成'));
    assert.strictEqual(ex.stage, 'arrival');
  });

  // 补齐签字后用“同一个操作对象”重试
  const ops = [signOp(ex, discrepancies, 'A', '保管员'), signOp(ex, discrepancies, 'B', '借展方')];
  processQueue({ exhibits: [ex], discrepancies }, ops);
  const r2 = processQueue({ exhibits: [ex], discrepancies }, r1.report.failed);
  check('复核补齐后重试成功，阶段推进，操作出队', () => {
    assert.strictEqual(r2.report.failed.length, 0);
    assert.strictEqual(ex.stage, 'install');
  });
}

console.log('5) 重试不覆盖他人已确认的差异数据');
{
  const disc = openDisc();
  const ex = makeExhibit();
  // A 的“确认解决”先失败，保留在重试队列
  const aResolve: QueueOp = {
    opId: 'op-resolve-a', type: 'resolve', device: 'A', at: 1, attempts: 1,
    discrepancyId: 'd1', recordId: 'ex-1', resolvedBy: '平板A', note: 'A 的意见'
  };
  // B 的确认先成功
  const bResolve: QueueOp = {
    opId: 'op-resolve-b', type: 'resolve', device: 'B', at: 2, attempts: 0,
    discrepancyId: 'd1', recordId: 'ex-1', resolvedBy: '平板B(他人)', note: '现场复检合格'
  };
  processQueue({ exhibits: [ex], discrepancies: [disc] }, [bResolve]);
  const r = processQueue({ exhibits: [ex], discrepancies: [disc] }, [aResolve]);
  check('他人已确认后 A 的重试幂等成功且不覆盖确认人与意见', () => {
    assert.strictEqual(r.report.failed.length, 0);
    assert.strictEqual(disc.status, 'resolved');
    assert.strictEqual(disc.resolvedBy, '平板B(他人)');
    assert.strictEqual(disc.note, '现场复检合格');
  });
}

console.log('6) 新记录按记录编号跨平板入库（不同编号不串档）');
{
  const ex = makeExhibit();
  const discrepancies: Discrepancy[] = [];
  const newRecord: QueueOp = {
    opId: 'op-new', type: 'upsert', device: 'C', at: 9, attempts: 0, recordId: 'ex-99',
    fields: { temperature: fv(19, 1, 0, 'C') }
  };
  const r = processQueue({ exhibits: [ex], discrepancies }, [newRecord]);
  check('未知记录编号作为新展品入库，不改动既有记录', () => {
    assert.strictEqual(r.report.applied, 1);
    assert.strictEqual(ex.id, 'ex-1');
    assert.ok(ex.fields.temperature.version === 1);
  });
}

console.log(`\n全部 ${passed} 项断言通过`);
