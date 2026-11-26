import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Witnesses check the conditions in each task, not an expected answer. Counts
// are minimum scenario coverage; ranking and presentation remain exam work.
export function checkExamCoverage(db, directory, {anchor} = {}) {
  const end = Date.parse(anchor);
  if (!Number.isFinite(end)) throw Error('Exam coverage requires an explicit anchor');
  const iso = n => new Date(n).toISOString();
  const day = 86400000;
  const sqlTime = n => `'${iso(n)}'`;
  const network = 'EntNetworkElement';
  const sw = "d.classification IN ('LSW','ne.category.switch')";
  const ap = "d.classification IN ('AP','ne.category.fatap')";
  const hq = "d.projectId IN (SELECT SITE_ID FROM X_SITE_VIEW WHERE SITE_NAME='江州总部')";
  const company = "d.tenantId IN (SELECT TENANT_ID FROM X_TENANT_VIEW WHERE TENANT_NAME='江州市澄川精密制造有限公司')";
  const flash = "d.subClassName='EnterpriseStorage'";
  const window = (start, stop, alias='k') => `${alias}.ts >= ${sqlTime(start)} AND ${alias}.ts < ${sqlTime(stop)}`;
  const recent = (days, alias='k') => window(end-days*day,end,alias);
  const lastDay = recent(1);
  const alarmWindow = `a.OCCURUTC >= ${end-day} AND a.OCCURUTC < ${end}`;
  const catalog = new Map();
  function add(ids, sql, minimum=1, note) {
    for (const id of ids.split(' ')) {
      if(catalog.has(id)) throw Error(`Duplicate exam coverage: ${id}`);
      catalog.set(id,{checks:[{sql, minimum}],...(note?{interpretation:note}: {})});
    }
  }
  function extra(id,sql,minimum=1){catalog.get(id).checks.push({sql,minimum});}
  const resources = (table,where='1') => `SELECT d.* FROM ${table} d WHERE ${where}`;
  const metric = (table,owner,where='1',time=lastDay) => `SELECT DISTINCT d.id FROM ${table} k JOIN ${owner} d ON k.resId=d.id WHERE ${where} AND ${time}`;
  const alarm = (owner,where='1',time='1') => `SELECT a.CSN FROM T_CURRENT_ALARM a JOIN ${owner} d ON a.MEDN=d.id WHERE ${where} AND ${time}`;
  const component = (table,owner,key,where='1') => `SELECT c.* FROM ${table} c JOIN ${owner} d ON c.parentResId=d.${key} WHERE ${where}`;
  const ports = (where='1',time=lastDay) => `SELECT DISTINCT k.resId FROM NetworkDeviceInterfaceKPI k JOIN ${network} d ON k.parentId=d.id WHERE ${where} AND ${time}`;
  add('A1-001',resources('HuaweiStorageDevice',`${flash} AND d.version LIKE '%1.1.0.SPH8%'`),2);
  extra('A1-001',resources('HuaweiStorageDevice',`${flash} AND d.version NOT LIKE '%1.1.0.SPH8%'`));
  add('A1-002',resources('FCSwitchDevice',"d.ipAddress!=''"));
  extra('A1-002',resources('FCSwitchDevice',"d.ipAddress='' OR d.ipAddress IS NULL"));
  add('A1-003',resources('EntPonElement',"d.classification='ne.category.pon.onu' AND d.productName='HG8245H'"),10);
  add('A1-004',resources('FCSwitchDevice','d.totalCapacity*1024 < 15176500772864'),1,'裸容量口径需澄清；总容量作为解释时须明确，并将 MB 转为 KB');
  add('A2-001',`SELECT s.* FROM HuaweiStorageDevice d JOIN X_SITE_VIEW s ON d.parentResId=s.SITE_ID WHERE d.subClassName='FusionStorageDevice' AND d.usedCapacity=0`);
  add('A2-002',`SELECT a.CSN FROM EnterpriseSlot c JOIN ${network} d ON c.refParentNE=d.id JOIN T_CURRENT_ALARM a ON a.MEDN=d.id WHERE ${sw} AND c.hardVersion='CEM48S4QP01 VER C' AND a.SEVERITY=3`);
  add('A2-003',alarm(network,`${sw} AND d.projectId IN (SELECT SITE_ID FROM X_SITE_VIEW WHERE SITE_NAME='江州智造园区')`));
  add('A2-004',`SELECT DISTINCT d.id FROM HuaweiStorageDevice d JOIN StorageDeviceKPI k ON k.resId=d.id WHERE k.memoryusage>30 AND ${recent(3)} AND EXISTS (SELECT 1 FROM T_CURRENT_ALARM a WHERE a.MEDN=d.id AND a.CLEARED=0 AND a.SEVERITY=3)`,1,'保留 30MB 瑕疵题：允许澄清，或明确解释为内存使用率超过 30%');
  const month = new Date(end); month.setUTCDate(1);month.setUTCHours(0,0,0,0);
  add('A3-001',metric('NetworkDeviceKPI',network,"d.name='10.137.171.74'",window(+month,end)));
  add('A3-002',`SELECT DISTINCT substr(k.ts,1,13) FROM NetworkDeviceKPI k JOIN ${network} d ON k.resId=d.id WHERE d.name='10.137.171.74' AND ${recent(3)}`,24);
  add('A3-003',metric('StorageDeviceKPI','HuaweiStorageDevice',flash,recent(3)),3);
  add('A3-004',`SELECT DISTINCT s.SITE_ID FROM NetworkDeviceKPI k JOIN ${network} d ON k.resId=d.id JOIN X_SITE_VIEW s ON d.projectId=s.SITE_ID WHERE s.SITE_NAME LIKE '江州智造园区%' AND d.classification IN ('AR','ne.category.router') AND ${window(Date.UTC(new Date(end).getUTCFullYear(),0,1),end)}`,2);
  add('B1-001',metric('PonDeviceKPI','EntPonElement',"d.classification='ne.category.olt' AND d.commuState='1' AND d.productName='MA5800'",recent(3)),5);
  add('B1-002',`SELECT DISTINCT d.id FROM PonDeviceKPI k JOIN EntPonElement d ON d.id=k.resId WHERE d.classification='ne.category.olt' AND k.memUsage>30 AND ${recent(3)} AND EXISTS (SELECT 1 FROM T_CURRENT_ALARM a WHERE a.MEDN=d.id AND a.CLEARED=0 AND a.SEVERITY=1)`);
  add('B1-003',metric('PonDeviceOnuKPI','EntPonElement',"d.classification='ne.category.pon.onu' AND d.commuState='0' AND d.productName='HG8245H'",recent(3)),5);
  add('B1-004','SELECT SEVERITY FROM T_CURRENT_ALARM GROUP BY SEVERITY HAVING count(*)>2',4);
  add('B2-001',"SELECT DISTINCT CATEGORY FROM T_DEVICE_ALL",5);
  add('B2-002',alarm('PhysicalServer',"a.ALARMNAME='OS用户SSH免密指纹文件内容格式错误告警'",`a.OCCURUTC >= ${end-93*day} AND a.OCCURUTC < ${end}`));
  add('B2-003',metric('NetworkDeviceKPI',network,"d.projectId IN (SELECT SITE_ID FROM X_SITE_VIEW WHERE SITE_NAME='江州高新园区') AND d.ipAddress LIKE '10.%'",recent(30)),2);
  add('B2-004',metric('NetworkDeviceKPI',network,'1',recent(1)),3);
  add('B3-001',`SELECT a.CSN FROM EnterpriseSlot c JOIN ${network} d ON c.refParentNE=d.id JOIN T_CURRENT_ALARM a ON a.MEDN=d.id WHERE ${sw} AND c.softVersion='V200R022C00SPC100' AND a.EVENTTYPE=13`);
  add('B3-002',metric('ServerDeviceKPI','PhysicalServer','1',window(+month,end)));
  extra('B3-002',metric('ServerDeviceKPI','PhysicalServer','1',window(Date.UTC(month.getUTCFullYear()-1,month.getUTCMonth(),1),Date.UTC(month.getUTCFullYear()-1,month.getUTCMonth()+1,1))));
  add('B3-003',alarm(network,`${sw} AND d.sn='1111111111112' AND a.ACKED=0`),20,'10 到 20 条允许澄清，或明确采用最多 20 条口径');
  add('B3-004',`SELECT l.id FROM EnterprisePhysicalLink l JOIN ${network} d ON d.id=l.aNeResId OR d.id=l.zNeResId WHERE d.sn='121516516546' AND d.classification IN ('AC','WAC','ne.category.ac')`);

  const c = n => `C1-${String(n).padStart(3,'0')}`;
  const cs = (...ns) => ns.map(c).join(' ');
  add(cs(1),resources('PhysicalServer','d.connectStatus=3'));
  add(cs(2,5),resources(network,`${hq} AND d.commuState='0'`),3);
  add(cs(3,93),resources('EnterprisePhysicalLink','d.linkStatus=2'),2);
  add(cs(4),`SELECT DISTINCT s.SITE_ID FROM X_SITE_VIEW s JOIN PhysicalServer d ON s.SITE_ID=d.refParentSubnet`);
  const hqAll = `SELECT id FROM ${network} d WHERE ${hq} UNION ALL SELECT id FROM PhysicalServer d WHERE ${hq} UNION ALL SELECT id FROM HuaweiStorageDevice d WHERE ${hq} UNION ALL SELECT id FROM EntPonElement d WHERE ${hq}`;
  add(cs(6,18,60,102),hqAll,10);
  add(cs(7),metric('NetworkDeviceKPI',network,`${hq} AND d.ipAddress LIKE '10.136.%'`,lastDay));
  add(cs(8),alarm(network,'a.CLEARED=0 AND a.SEVERITY=2'));
  add(cs(9),metric('NetworkDeviceKPI',network,hq,lastDay),2);
  add(cs(10),resources(network,`${sw} AND d.manufacturer!='华为'`));
  add(cs(11),component('PhysicalServerPSU','PhysicalServer','oriResId','c.healthStatus!=0'),1,'电源无离线通信状态：应澄清，或明确改用健康状态口径');
  add(cs(12),alarm(network,"a.ALARMNAME='Route Change'",alarmWindow));
  add(cs(13),metric('NetworkDeviceKPI',network,`${hq} AND k.cpuUsage>70 AND k.memUsage>70`,lastDay));
  add(cs(14),metric('NetworkDeviceKPI',network,'1',lastDay),3);
  add(cs(15),alarm(network,"d.name='Core-SW-01' AND a.SEVERITY=1"));
  add(cs(16),`SELECT DISTINCT MEDN FROM T_CURRENT_ALARM WHERE OCCURUTC>=${end-7*day} AND OCCURUTC<${end}`,10);
  add(cs(17,56),resources(network,company),5);
  add(cs(19),resources(network,`${company} AND d.commuState='0'`),3);
  add(cs(20),resources(network,"d.mac LIKE '%9E-CB-73%'"));
  add(cs(21),`SELECT c.* FROM EnterpriseSlot c JOIN ${network} d ON c.refParentNE=d.id WHERE d.mac LIKE '%9E-CB-73%'`);
  add(cs(22,23,50),`SELECT l.* FROM EnterprisePhysicalLink l JOIN ${network} d ON l.aNeResId=d.id OR l.zNeResId=d.id WHERE d.name='Core-SW-01'`,2);
  add(cs(24,25),metric('NetworkDeviceKPI',network,'1',lastDay),5);
  add(cs(26),resources('PhysicalServer',`${company} AND d.connectStatus=3`));
  add(cs(27,28,29),ports(`${hq} AND k.ifInBandRate<50`));
  add(cs(30),alarm(network,`${company} AND a.SEVERITY=2`));
  add(cs(31),alarm(network,`${hq} AND a.SEVERITY=2`));
  add(cs(32,57),resources('PhysicalServer',`${company} AND d.manufacturer='华为'`),2);
  add(cs(33),metric('ServerDeviceKPI','PhysicalServer',"d.manufacturer='华为' AND k.memUsage>70",recent(3)));
  add(cs(34),component('PhysicalServerDisk','PhysicalServer','oriResId',hq));
  add(cs(35,36),component('SYS_Fan','HuaweiStorageDevice','id',hq));
  add(cs(37),ports(hq,lastDay),4);
  add(cs(38,39),ports(hq),4);
  add(cs(40),ports(`${hq} AND k.ifInBandRate<50`,lastDay));
  add(cs(41),ports(`${hq} AND k.ifInBandRate>50`,lastDay));
  add(cs(44,45),alarm(network,`${hq} AND a.ALARMNAME='Route Change'`));
  add(cs(46),alarm(network,company,alarmWindow));
  add(cs(47),alarm(network,hq,alarmWindow));
  add(cs(48),`SELECT p.id FROM EnterpriseNetworkLTP p JOIN ${network} d ON p.refParentNE=d.id WHERE ${hq} AND p.operState='active'`,1,'Up 明确解释为接口 Active，不能按物理链路状态解释');
  add(cs(49),`SELECT p.id FROM EnterpriseNetworkLTP p JOIN ${network} d ON p.refParentNE=d.id WHERE ${company} AND p.operState='active'`,1,'Up 明确解释为接口 Active');
  add(cs(51),`SELECT s.* FROM X_SITE_VIEW s JOIN ${network} d ON d.projectId=s.SITE_ID WHERE d.name='Core-SW-01'`);
  add(cs(52),`SELECT * FROM EnterprisePhysicalLink WHERE linkStatus=2 AND ((aNeName='Core-SW-01' AND zNeName='Acc-SW-01') OR (zNeName='Core-SW-01' AND aNeName='Acc-SW-01'))`);
  const terminals = where => `SELECT t.resId FROM EntTerminalElement t JOIN ${network} d ON t.accessDeviceId=d.id WHERE d.name='Acc-SW-01' AND ${where}`;
  add(cs(53),terminals('1'),4);add(cs(54),terminals("t.vendor='联想'"),2);add(cs(55),terminals('t.status=-1'));
  add(cs(58),alarm('PhysicalServer',"d.manufacturer='华为'"));
  add(cs(59),resources('EntTerminalElement',"d.vendor='联想'"),2);
  add(cs(61),`SELECT c.* FROM EnterpriseFrame c JOIN ${network} d ON c.refParentNE=d.id WHERE ${hq}`);
  add(cs(62),`SELECT c.* FROM EnterpriseSlot c JOIN ${network} d ON c.refParentNE=d.id WHERE ${hq} AND c.operstatus IN (3,11,13,15,16)`);
  add(cs(63),resources(network,`${hq} AND d.commuState='0'`));
  add(cs(64),alarm(network,"d.name='Core-SW-01' AND a.CLEARED=0"));
  add(cs(65),metric('PonDeviceOnuKPI','EntPonElement','k.onuhwOpticsTemperature>40',recent(3)),1,'温度明确采用 ONU 光模块口径');
  add(cs(66),metric('PonDeviceOnuKPI','EntPonElement','k.onuHwOpticsTxPower<2',recent(3)),1,'发送光功率明确采用 ONU 光模块口径');
  add(cs(67),resources('EntTerminalElement',"d.mac='9E-CB-73-34-64-25'"));
  add(cs(68),metric('NetworkDeviceKPI',network,sw),5);
  add(cs(69),resources(network,"d.ipAddress='10.136.253.11'"));
  add(cs(70),component('SYS_StoragePort','HuaweiStorageDevice','id',hq));
  add(cs(71),metric('NetworkDeviceKPI',network,`${company} AND k.nePingRespTime>0`));
  add(cs(72),resources('HuaweiStorageDevice',company));
  add(cs(73),resources('EntTerminalElement',company));
  add(cs(74),metric('NetworkDeviceKPI',network,hq));
  add(cs(75),`SELECT DISTINCT c.id FROM NetworkDeviceBoardKPI k JOIN EnterpriseSlot c ON c.id=k.resId JOIN ${network} d ON c.refParentNE=d.id WHERE ${hq} AND ${lastDay}`);
  add(cs(76),component('SYS_Controller','HuaweiStorageDevice','id',hq));
  add(cs(77),component('PhysicalServerFan','PhysicalServer','oriResId'));
  add(cs(78),metric('ServerDeviceKPI','PhysicalServer',`${hq} AND d.healthStatus=0`),2);
  add(cs(79),component('SYS_BackupPower','HuaweiStorageDevice','id',hq));
  // This task asks whether a metric exists, rather than requesting its values.
  catalog.set(c(80),{checks:[],boundary:'当日不可达比率未发布；不得把在线率补数冒充该指标'});
  add(cs(81),resources(network,`${ap} AND d.commuState='1'`));
  add(cs(82),component('PhysicalServerPSU','PhysicalServer','oriResId',"d.name LIKE '%江州计算%' AND c.ratedPower>800"));
  add(cs(83),resources('HuaweiStorageDevice','d.connectStatus=1'));
  add(cs(84),alarm('PhysicalServer','d.connectStatus=3'));
  add(cs(85,97),resources('PhysicalServer'),10);
  add(cs(86),resources('PhysicalServer',"d.classification='ne.category.server.rack'"));
  add(cs(87,88),resources(network,"d.name='Core-SW-01'"));
  add(cs(89),`SELECT t.resId FROM EntTerminalElement t JOIN ${network} d ON t.accessDeviceId=d.id WHERE t.name='生产终端-01'`);
  add(cs(90),resources(network,`${hq} AND ${ap}`));
  add(cs(91),resources(network,"d.sn='JZ-NET-000001'"));
  add(cs(92),resources('PhysicalServer',"d.sn='JZ-SRV-000001'"));
  add(cs(94),resources('PhysicalServer','d.healthStatus=-2'),1,'编码 -2 表达未知，须澄清或明确按给定编码而非故障解释');
  add(cs(95),component('PhysicalServerDisk','PhysicalServer','oriResId','d.healthStatus=-2'),1,'编码 -2 表达未知');
  add(cs(96),resources('EnterprisePhysicalLink',company));
  add(cs(98),resources(network,sw),10);
  add(cs(99),resources(network,"d.classification IN ('FW','ne.category.firewall')"));
  add(cs(100),resources('HuaweiStorageDevice'),10);
  add(cs(101),'SELECT * FROM X_TENANT_VIEW',20);

  const t = n => `T1-${String(n).padStart(3,'0')}`;
  const alarmsRecent = days => `SELECT * FROM T_CURRENT_ALARM a WHERE a.OCCURUTC>=${end-days*day} AND a.OCCURUTC<${end}`;
  add(t(1),`SELECT SEVERITY FROM (${alarmsRecent(3)}) GROUP BY SEVERITY`,4);
  add(t(2),metric('NetworkDeviceKPI',network,'1',recent(3)),5);
  add(t(3),`SELECT TENANTID FROM (${alarmsRecent(3)}) WHERE CLEARED=0 GROUP BY TENANTID`,5);
  add(t(4),metric('ServerDeviceKPI','PhysicalServer','1',recent(1)),5);
  add(t(5),ports('1',recent(1)),5);
  add(t(6),`SELECT d.classification,d.tenantId FROM NetworkDeviceKPI k JOIN ${network} d ON d.id=k.resId WHERE ${recent(3)} GROUP BY d.classification,d.tenantId`,5);
  add(t(7),metric('NetworkDeviceKPI',network,'1',recent(1)),10);extra(t(7),ports('1',recent(1)),10);
  add(t(8),`SELECT k.parentId FROM PonDeviceOnuKPI k WHERE ${recent(3)} GROUP BY k.parentId`,10);
  add(t(9),alarmsRecent(14));extra(t(9),resources(network,"d.commuState='1'"));
  add(t(10),`SELECT DISTINCT k.resId FROM NetworkApRadioSsidKPI k WHERE ${recent(1)}`,5);
  extra(t(10),metric('NetworkDeviceKPI',network,ap,recent(1)));
  add(t(11),`SELECT DISTINCT substr(k.ts,1,10) FROM NetworkDeviceKPI k WHERE ${recent(14)}`,14);
  extra(t(11),metric('NetworkDeviceKPI',network,'1',recent(14)),10);
  add(t(12),`SELECT TENANTID FROM (${alarmsRecent(14)}) WHERE CLEARED=0 GROUP BY TENANTID`,11);
  extra(t(12),`SELECT ALARMNAME FROM (${alarmsRecent(14)}) GROUP BY ALARMNAME`,20);
  extra(t(12),`SELECT MECATEGORY FROM (${alarmsRecent(14)}) GROUP BY MECATEGORY`,6);
  add(t(13),`SELECT k.parentId FROM PonDeviceOnuKPI k WHERE ${recent(3)} GROUP BY k.parentId`,10);
  extra(t(13),`SELECT DISTINCT k.parentId FROM PonDevicePonPortKPI k WHERE ${recent(3)}`,10);
  add(t(14),metric('ServerDeviceKPI','PhysicalServer','1',recent(1)),10);
  extra(t(14),'SELECT DISTINCT healthStatus FROM PhysicalServer',3);
  add(t(15),'SELECT DISTINCT tenantId FROM HuaweiStorageDevice',10);
  add(t(16),`SELECT DISTINCT d.classification FROM NetworkDeviceKPI k JOIN ${network} d ON d.id=k.resId WHERE ${recent(3)}`,5);
  add(t(17),`SELECT SEVERITY FROM (${alarmsRecent(7)}) GROUP BY SEVERITY`,4);
  add(t(18),`SELECT DISTINCT k.resId FROM NetworkDeviceOnlineKPI k WHERE ${recent(7)}`,10);

  const files = readdirSync(directory,{withFileTypes:true}).filter(x=>x.isDirectory()).flatMap(x=>
    readdirSync(join(directory,x.name)).filter(f=>/\.md$/.test(f)).map(f=>join(directory,x.name,f))).sort();
  const results = files.map(file=>{
    const id=file.split('/').at(-1).replace(/\.md$/,'');
    const source=readFileSync(file,'utf8'), spec=catalog.get(id);
    if(!spec)throw Error(`No data coverage contract for question ${id}`);
    const task=source.split('## 任务')[1]?.split('## ')[0]?.trim();
    if(!task)throw Error(`Question ${id} has no task`);
    const checks=spec.checks.map(check=>{
      const rows=db.prepare(`SELECT count(*) n FROM (${check.sql})`).get().n;
      return {...check,rows,passed:rows>=check.minimum};
    });
    return {id,task,sha256:createHash('sha256').update(source).digest('hex'),
      status:spec.boundary?'capability-boundary':spec.interpretation?'requires-interpretation':'data-answerable',
      ...spec,checks};
  });
  const ids=new Set(results.map(r=>r.id));
  const missing=[...catalog.keys()].filter(id=>!ids.has(id));
  if(results.length!==142 || missing.length)throw Error(`Exam inventory mismatch: ${results.length} questions; missing ${missing.join(', ')}`);
  const failed=results.filter(r=>r.checks.some(c=>!c.passed));
  if(failed.length)throw Error(`Exam data coverage failed:\n${failed.map(r=>`${r.id}: ${r.checks.filter(c=>!c.passed).map(c=>`${c.rows}/${c.minimum} witnesses: ${c.sql}`).join('; ')}`).join('\n')}`);
  return {format:'ic-exam-coverage/v1',anchor:iso(end),questions:results.length,results};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(process.argv[2],{readOnly:true});
  try {console.log(JSON.stringify(checkExamCoverage(db,process.argv[3],{anchor:process.argv[4]}),null,2));}
  finally {db.close();}
}
