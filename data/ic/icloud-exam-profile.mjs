// Business witnesses for the IC examination corpus. Background populations and
// waveforms remain seeded; this profile supplies named assets and edge cases.
const day=86400000;
export function prepareExamAssets(rows,{anchorMs,availability}) {
 const network=rows.get('EntNetworkElement'),sites=rows.get('X_SITE_VIEW');
 if(network.length<120)throw Error('The complete exam profile requires at least 120 base resources');
 const hq=sites.find(s=>s.SITE_NAME==='江州总部');
 const company=hq.TENANT_ID,protectedRows=new Set();
 const forbidden=new Set(sites.filter(s=>['江州智造园区','江州智造园区东区','江州高新园区'].includes(s.SITE_NAME)).map(s=>s.SITE_ID));
 for(const r of network)if(forbidden.has(r.projectId))protectedRows.add(r);
 const switches=network.filter(r=>['LSW','ne.category.switch'].includes(r.classification)&&!forbidden.has(r.projectId));
 if(switches.length<5)throw Error('Exam profile needs five switch witnesses outside the reserved park scenarios');
 const [core,access,ipSwitch,...extra]=switches;
 for(const r of [core,access,ipSwitch,...extra.slice(0,2)])protectedRows.add(r);
 function place(r,site,peers=network){
  if(r.tenantId!==site.TENANT_ID){
   const donor=peers.find(other=>!protectedRows.has(other)&&other.tenantId===site.TENANT_ID);
   if(!donor)throw Error('Insufficient tenant population for a declared exam scenario');
   const previous=r.tenantId;donor.tenantId=previous;
   const ownSite=sites.find(s=>s.TENANT_ID===previous);
   donor.projectId=ownSite.SITE_ID;if('refParentSubnet'in donor)donor.refParentSubnet=ownSite.SITE_ID;
   r.tenantId=site.TENANT_ID;
  }
  r.projectId=site.SITE_ID;
  for(const key of ['refParentSubnet','parentResId','siteId'])if(key in r)r[key]=site.SITE_ID;
 }
 for(const r of [core,access,ipSwitch,...extra.slice(0,2)])place(r,hq);
 Object.assign(core,{name:'Core-SW-01',alias:'Core-SW-01',sn:'JZ-NET-000001',mac:'9E-CB-73-34-64-25',ipAddress:'10.136.253.11'});
 Object.assign(access,{name:'Acc-SW-01',alias:'Acc-SW-01',sn:'1111111111112',mac:'9E-CB-73-34-64-26',ipAddress:'10.136.253.12'});
 Object.assign(ipSwitch,{name:'10.137.171.74',alias:'10.137.171.74',ipAddress:'10.137.171.74'});
 const controller=network.find(r=>['WAC','AC','ne.category.ac'].includes(r.classification)&&!forbidden.has(r.projectId));
 Object.assign(controller,{name:'江州园区AC-01',alias:'江州园区AC-01',sn:'121516516546'});
 protectedRows.add(controller);place(controller,hq);
 const ap=network.find(r=>['AP','ne.category.fatap'].includes(r.classification)&&!forbidden.has(r.projectId));
 protectedRows.add(ap);place(ap,hq);
 availability.schedule(ap,anchorMs-30*60000,anchorMs+30*60000);
 availability.schedule(access,anchorMs-60*60000,anchorMs+60*60000);
 for(const r of network)r.commuState=availability.rate(r,anchorMs-1,1)===0?'1':'0';
 const servers=rows.get('PhysicalServer');
 for(const r of servers.slice(0,4)){protectedRows.add(r);place(r,hq,servers);r.manufacturer='华为';}
 Object.assign(servers[0],{name:'江州计算-01',sn:'JZ-SRV-000001',classification:'ne.category.server.rack',healthStatus:0,connectStatus:1});
 Object.assign(servers[1],{name:'江州计算-02',healthStatus:-2,connectStatus:3});
 Object.assign(servers[2],{healthStatus:0,connectStatus:1});
 const storage=rows.get('HuaweiStorageDevice');
 const flash=storage.filter(r=>r.subClassName==='EnterpriseStorage');
 if(flash.length<4)throw Error('Exam profile requires four flash-storage witnesses');
 for(const r of flash.slice(0,4)){protectedRows.add(r);place(r,hq,storage);}
 flash[0].version='OceanStor 1.1.0.SPH8';flash[1].version='OceanStor 1.1.0.SPH8.P1';
 flash[2].version='OceanStor 1.1.0.SPH7';
 const distributed=storage.filter(r=>r.subClassName==='FusionStorageDevice');
 if(distributed.length<2)throw Error('Exam profile requires distributed storage witnesses');
 distributed[0].version='OceanStor 1.1.0.SPH8';
 Object.assign(distributed[0],{usedCapacity:0,unUsedCapacity:distributed[0].totalCapacity,usedCapacityRate:0});
 protectedRows.add(distributed[0]);place(distributed[0],hq,storage);
 rows.get('FCSwitchDevice')[0].ipAddress='';
 const pon=rows.get('EntPonElement'),olts=pon.filter(r=>r.classification==='ne.category.olt'),onus=pon.filter(r=>r.classification==='ne.category.pon.onu');
 olts.forEach((r,i)=>Object.assign(r,{manufacturer:'华为',productName:i<12?'MA5800':'MA5600',commuState:i<8?'1':r.commuState}));
 onus.forEach((r,i)=>Object.assign(r,{manufacturer:'华为',productName:i<24?'HG8245H':'HG8145V5',commuState:i<8?'0':r.commuState}));
 Object.assign(olts[0],{tenantId:company,projectId:hq.SITE_ID,refParentSubnet:hq.SITE_ID});
 for(const r of pon){const parent=olts.find(o=>o.id===r.parentOltResId);if(parent)for(const key of ['tenantId','projectId','refParentSubnet'])r[key]=parent[key];}
 return {core,access,ipSwitch,controller,ap,servers,flash,distributed,olts,onus,hq,anchorMs};
}
export function finishExamAssets(rows,s){
 const slots=rows.get('EnterpriseSlot');
 Object.assign(slots[0],{refParentNE:s.core.id,tenantId:s.core.tenantId,projectId:s.core.projectId,
  hardVersion:'CEM48S4QP01 VER C',softVersion:'V200R022C00SPC100',operstatus:3});
 const frames=rows.get('EnterpriseFrame');
 Object.assign(frames[0],{refParentNE:s.core.id,tenantId:s.core.tenantId,projectId:s.core.projectId});
 slots[0].frameNativeId=frames[0].frameDn;
 const psus=rows.get('PhysicalServerPSU');
 Object.assign(psus[0],{parentResId:s.servers[0].oriResId,tenantId:s.servers[0].tenantId,projectId:s.servers[0].projectId,ratedPower:1200,healthStatus:3});
 Object.assign(psus[1],{parentResId:s.servers[1].oriResId,tenantId:s.servers[1].tenantId,projectId:s.servers[1].projectId,ratedPower:600,healthStatus:0});
 const terminals=rows.get('EntTerminalElement');
 for(const [i,t]of terminals.slice(0,4).entries())Object.assign(t,{accessDeviceId:s.access.id,tenantId:s.access.tenantId,siteId:s.access.projectId,projectId:s.access.projectId,
  vendor:i<2?'联想':'戴尔',status:i===0?-1:0});
 Object.assign(terminals[0],{name:'生产终端-01',mac:'9E-CB-73-34-64-25'});
 const link=(r,a,z,status)=>{
  Object.assign(r,{aNeResId:a.id,zNeResId:z.id,aNeName:a.name,zNeName:z.name,
   aNeIp:a.ipAddress,zNeIp:z.ipAddress,tenantId:a.tenantId,projectId:a.projectId,linkStatus:status});
  for(const [prefix,owner] of [['a',a],['z',z]]){
   const p=rows.get('EnterpriseNetworkLTP').find(p=>p.refParentNE===owner.id);
   Object.assign(r,{[prefix+'PortName']:p.name,[prefix+'PortAlias']:p.alias,[prefix+'PortDn']:p.id,[prefix+'PortIp']:p.ipAddress});
  }
 };
 const links=rows.get('EnterprisePhysicalLink');
 link(links[0],s.core,s.access,2);link(links[1],s.core,s.ipSwitch,0);link(links[2],s.controller,s.core,2);
}
export function appendExamAlarms(alarms,rows,s,alarmProfile){
 const add=(family,owner,name,time,{severity=2,acked=1,cleared=0,eventtype}={})=>{
  const template=alarms.find(a=>a.MECATEGORY===({EntNetworkElement:'NetworkElement',PhysicalServer:'PhysicalServer',HuaweiStorageDevice:'HuaweiStorageDevice',EntPonElement:'EntPonElement'}[family]));
  if(!template)throw Error('Missing alarm scenario family '+family);
  const row={...template,...alarmProfile(family,owner,rows.get('EnterpriseNetworkLTP'))};delete row.ports;
  Object.assign(row,{CSN:alarms.length+1,ALARMNAME:name,SEVERITY:severity,ACKED:acked,CLEARED:cleared,MOI:'',
   OCCURUTC:time,OCCURTIME:time,LATESTOCCURUTC:time,LATESTOCCURTIME:time,ARRIVEUTC:time+1000,
   ACKUTC:acked?time+1000:0,CLEARUTC:cleared?time+2000:0,CLEARTIME:cleared?time+2000:0,ENDUTC:cleared?time+2000:0,COMMENTUTC:acked?time+1000:0});
  row.TENANT=rows.get('X_TENANT_VIEW').find(t=>t.TENANT_ID===owner.tenantId)?.TENANT_NAME ?? '';
  row.LOCATION=owner.projectId ?? owner.name;
  if(eventtype!==undefined)row.EVENTTYPE=eventtype;
  alarms.push(row);
 };
 for(let i=0;i<25;i++)add('EntNetworkElement',s.access,'SNMP 采集超时',s.anchorMs-(i+1)*3600000,{acked:0,severity:i%4+1});
 const october=Date.parse('2026-10-13T12:30:00Z');
 if(october>=s.startMs&&october<s.anchorMs){
  add('EntNetworkElement',s.core,'Route Change',october,{severity:1});
  add('EntNetworkElement',s.core,'对象删除',october+3600000,{severity:3,eventtype:13});
 }
 add('EntNetworkElement',s.core,'对象删除',s.anchorMs-day,{severity:3,eventtype:13});
 add('PhysicalServer',s.servers[0],'OS用户SSH免密指纹文件内容格式错误告警',s.anchorMs-2*day);
 add('PhysicalServer',s.servers[1],'服务器管理接口不可达',s.anchorMs-day,{severity:2});
 add('HuaweiStorageDevice',s.flash[0],'存储缓存使用率过高',s.anchorMs-day,{severity:3});
 add('EntPonElement',s.olts[0],'OLT 管理通道异常',s.anchorMs-day,{severity:1});
}
export function examMetric(s,table,column,ownerId,time,value){
 if(table==='ServerDeviceKPI'&&time<s.startMs){
  if(column==='cpuUsage')return 32+s.servers.findIndex(r=>r.id===ownerId)%10+4*Math.sin(time/day);
  if(column==='memUsage')return 42+3*Math.cos(time/day);
 }
 if(table==='NetworkDeviceKPI'&&[s.core.id,s.ipSwitch.id].includes(ownerId)){
  if(column==='cpuUsage')return 88+3*Math.sin(time/day);
  if(column==='memUsage')return 86+4*Math.cos(time/day);
 }
 if(table==='StorageDeviceKPI'&&ownerId===s.flash[0].id&&column==='memoryusage')return 65+8*Math.sin(time/day);
 if(table==='PonDeviceKPI'&&ownerId===s.olts[0].id&&column==='memUsage')return 70+6*Math.cos(time/day);
 return value;
}
export function examExtraTimes(table,anchorMs){
 if(!/KPI$/.test(table))return [];
 const times=[];
 for(const d of ['2026-10-13','2026-10-14'])for(const h of [0,8,14,15,16,17])times.push(Date.parse(`${d}T${String(h).padStart(2,'0')}:30:00Z`));
 if(table==='ServerDeviceKPI'){
  const date=new Date(anchorMs),year=date.getUTCFullYear()-1,month=date.getUTCMonth();
  for(let d=1;d<=new Date(Date.UTC(year,month+1,0)).getUTCDate();d++)times.push(Date.UTC(year,month,d,12));
 }
 return times;
}
