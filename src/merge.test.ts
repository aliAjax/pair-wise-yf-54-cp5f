import { mergeReading, mergeStatus, mergeSign, mergeResolveDiscrepancy, revalidateSignatures } from './services/merge';
import type { Exhibit, Discrepancy, ReadingField } from './stores/exhibition';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

function makeExhibit(): Exhibit {
  return {
    id: 'ex-1', code: 'M001', name: '测试展品', lender: '方', hall: '柜',
    stage: 'arrival',
    status: { value: 'pending', version: 1, source: '初始', at: 0, confirmed: false },
    statusHistory: [{ value: 'pending', version: 1, source: '初始', at: 0, confirmed: false, superseded: false }],
    environment: {
      temperature: { value: 22, version: 1, source: '初始', at: 0, confirmed: false },
      humidity: { value: 50, version: 1, source: '初始', at: 0, confirmed: false },
      light: { value: 150, version: 1, source: '初始', at: 0, confirmed: false }
    },
    readings: [
      { field: 'temperature', value: 22, version: 1, source: '初始', at: 0, confirmed: false, superseded: false },
      { field: 'humidity', value: 50, version: 1, source: '初始', at: 0, confirmed: false, superseded: false },
      { field: 'light', value: 150, version: 1, source: '初始', at: 0, confirmed: false, superseded: false }
    ],
    signatures: [],
    discrepancyVersion: 1
  };
}

console.log('场景1: 干净合并（baseVersion >= 当前版本）');
{
  const ex = makeExhibit();
  const r = mergeReading(ex, 'temperature', 23.5, 1, '平板-A1', 1000);
  check('返回 merged', r.status === 'merged');
  check('当前值更新为 23.5', ex.environment.temperature.value === 23.5);
  check('版本升到 2', ex.environment.temperature.version === 2);
  check('来源标记为 平板-A1', ex.environment.temperature.source === '平板-A1');
  check('旧版读数已作废', ex.readings.find((x) => x.version === 1)?.superseded === true);
}

console.log('场景2: 版本冲突（baseVersion < 当前版本）保留两版并标明来源');
{
  const ex = makeExhibit();
  mergeReading(ex, 'temperature', 23.5, 1, '平板-B2', 1000); // 先合并到 v2
  const r = mergeReading(ex, 'temperature', 21.0, 1, '平板-C3', 2000); // 基于 v1 提交
  check('返回 conflict', r.status === 'conflict');
  check('当前值保持高版本 23.5', ex.environment.temperature.value === 23.5);
  const active = ex.readings.filter((x) => x.field === 'temperature' && !x.confirmed && !x.superseded);
  check('保留两个未作废版本', active.length === 2);
  check('两版来源分别为 B2 / C3', active.some((x) => x.source === '平板-B2') && active.some((x) => x.source === '平板-C3'));
  check('冲突原因含复核提示', (r.reason ?? '').includes('需复核确认'));
}

console.log('场景3: 冲突导致原签字失效');
{
  const ex = makeExhibit();
  mergeSign(ex, '保管员', '平板-A1', 500, { temperature: 22, humidity: 50, light: 150 }, 1);
  check('签字初始有效', ex.signatures[0].valid === true);
  mergeReading(ex, 'temperature', 23.5, 1, '平板-B2', 1000);
  mergeReading(ex, 'temperature', 21.0, 1, '平板-C3', 2000); // 冲突
  check('冲突后签字失效', ex.signatures[0].valid === false);
  check('失效原因已记录', (ex.signatures[0].invalidReason ?? '').includes('需复核'));
}

console.log('场景4: 差异版本变更让签字失效');
{
  const ex = makeExhibit();
  const d: Discrepancy = { id: 'd1', exhibitId: 'ex-1', title: '差异', severity: 'major', resolved: false, version: 1 };
  mergeSign(ex, '借展方', '平板-A1', 500, { temperature: 22, humidity: 50, light: 150 }, 1);
  mergeResolveDiscrepancy(d, ex, '平板-B2');
  check('差异标记为已解决', d.resolved === true);
  check('差异版本升到 2', d.version === 2);
  check('展品差异版本升到 2', ex.discrepancyVersion === 2);
  check('签字失效', ex.signatures[0].valid === false);
}

console.log('场景5: 复核确认后重试不可覆盖他人已确认数据');
{
  const ex = makeExhibit();
  mergeReading(ex, 'temperature', 23.5, 1, '平板-B2', 1000);
  mergeReading(ex, 'temperature', 21.0, 1, '平板-C3', 2000); // 冲突
  // 复核：确认采用 B2 的 23.5
  ex.environment.temperature.value = 23.5;
  ex.environment.temperature.version += 1;
  ex.environment.temperature.source = '平板-A1';
  ex.environment.temperature.confirmed = true;
  for (const rec of ex.readings) {
    if (rec.field !== 'temperature') continue;
    if (!rec.confirmed && !rec.superseded && rec.value === 23.5) rec.confirmed = true;
    else if (!rec.confirmed) rec.superseded = true;
  }
  // C3 重试（基于旧 baseVersion）试图覆盖
  const r = mergeReading(ex, 'temperature', 21.0, 1, '平板-C3', 3000);
  check('重试返回 failed', r.status === 'failed');
  check('失败原因含已确认不可覆盖', (r.reason ?? '').includes('不可覆盖'));
  check('当前值仍是已确认的 23.5', ex.environment.temperature.value === 23.5);
}

console.log('场景6: 签字幂等去重（重复处理仍算一项）');
{
  const ex = makeExhibit();
  const r1 = mergeSign(ex, '保管员', '平板-A1', 500, { temperature: 22, humidity: 50, light: 150 }, 1);
  const r2 = mergeSign(ex, '保管员', '平板-A1', 600, { temperature: 22, humidity: 50, light: 150 }, 1);
  check('首次 merged', r1.status === 'merged');
  check('重复 duplicate', r2.status === 'duplicate');
  check('只有一条签字', ex.signatures.length === 1);
}

console.log('场景7: 条件冲突同样保留两版');
{
  const ex = makeExhibit();
  mergeStatus(ex, 'passed', 1, '平板-B2', 1000);
  const r = mergeStatus(ex, 'issue', 1, '平板-C3', 2000);
  check('条件冲突返回 conflict', r.status === 'conflict');
  const active = ex.statusHistory.filter((x) => !x.confirmed && !x.superseded);
  check('条件保留两个未作废版本', active.length === 2);
}

console.log('场景8: 复核后读数与差异版本仍吻合的签字恢复有效');
{
  const ex = makeExhibit();
  mergeSign(ex, '保管员', '平板-A1', 500, { temperature: 22, humidity: 50, light: 150 }, 1);
  mergeReading(ex, 'temperature', 23.5, 1, '平板-B2', 1000);
  mergeReading(ex, 'temperature', 21.0, 1, '平板-C3', 2000);
  check('冲突后失效', ex.signatures[0].valid === false);
  // 复核确认采用 23.5（与签字快照 22 不吻合 → 仍失效，需重新签字）
  ex.environment.temperature.value = 23.5;
  ex.environment.temperature.version += 1;
  ex.environment.temperature.confirmed = true;
  for (const rec of ex.readings) {
    if (rec.field !== 'temperature') continue;
    if (!rec.confirmed && !rec.superseded && rec.value === 23.5) rec.confirmed = true;
    else if (!rec.confirmed) rec.superseded = true;
  }
  revalidateSignatures(ex);
  check('读数已变更，签字仍失效需重签', ex.signatures[0].valid === false);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) throw new Error(`${fail} 项验证失败`);
