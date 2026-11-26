import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {checkExamCoverage} from '../data/ic/coverage.mjs';

const [database,questions,anchor]=process.argv.slice(2);
assert(database && questions && anchor,'Usage: node scripts/tests/icloud-exam.test.mjs <database> <questions> <anchor>');
// Savepoints make these destructive counterexamples reversible. Each mutation
// removes a different witness that a table-count-only check would miss.
const db=new DatabaseSync(database);
try {
  const report=checkExamCoverage(db,questions,{anchor});
  assert.equal(report.questions,142);
  assert.equal(report.results.find(q=>q.id==='A2-004').status,'requires-interpretation');
  assert.match(report.results.find(q=>q.id==='A2-004').task,/30MB/);
  for(const [question,sql]of [
    ['A1-001',"UPDATE HuaweiStorageDevice SET version='nonmatching' WHERE subClassName='EnterpriseStorage'"],
    ['B3-004',"UPDATE EntNetworkElement SET sn='different' WHERE sn='121516516546'"],
    ['B3-002',"DELETE FROM ServerDeviceKPI WHERE ts<'2026-01-01'"],
    ['C1-052',"UPDATE EnterprisePhysicalLink SET linkStatus=0 WHERE (aNeName='Core-SW-01' AND zNeName='Acc-SW-01') OR (zNeName='Core-SW-01' AND aNeName='Acc-SW-01')"],
    ['C1-013',`UPDATE NetworkDeviceKPI SET memUsage=30 WHERE ts>='${new Date(Date.parse(anchor)-86400000).toISOString()}' AND ts<'${new Date(anchor).toISOString()}'`],
    ['A2-004',"UPDATE T_CURRENT_ALARM SET CLEARED=1 WHERE SEVERITY=3 AND MEDN IN (SELECT id FROM HuaweiStorageDevice)"],
  ]) {
    db.exec('SAVEPOINT coverage_counterexample');
    try {
      db.exec(sql);
      assert.throws(()=>checkExamCoverage(db,questions,{anchor}),e=>e.message.includes(question),question);
    } finally {db.exec('ROLLBACK TO coverage_counterexample; RELEASE coverage_counterexample');}
  }
  console.log('Passed: 142 question contracts, preserved ambiguous task, six missing-scenario counterexamples');
} finally {db.close();}
