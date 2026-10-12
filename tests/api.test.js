import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseCSV,toCSV} from '../src/shared.js';

let dir,server,base,db;
before(async()=>{dir=await mkdtemp(join(tmpdir(),'whatnot-test-'));process.env.DB_PATH=join(dir,'test.sqlite');const mod=await import('../server.js');db=mod.db;server=mod.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;});
after(async()=>{await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});});
async function request(path,body,method='POST') {const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
const expense=(extra={})=>({date:'2026-10-12',type:'expense',currency:'CNY',amount:'80',description:'采购纸箱',account_id:1,fx_rate:1,...extra});
const state=async()=> (await request('/state')).body;

test('人民币支出、美元收入保存原币与当次汇率；更改默认值不改变历史',async()=>{
 const a=await request('/entries',expense());assert.equal(a.status,201);
 const b=await request('/entries',expense({type:'income',currency:'USD',amount:'100',account_id:2,fx_rate:'7.1',description:'Whatnot到账'}));assert.equal(b.status,201);
 await request('/settings',{fx_rate:7.5,timezone:'Asia/Shanghai'},'PUT');
 const d=await state();const e=d.entries.find(x=>x.id===b.body.id);assert.equal(e.amount_cents,10000);assert.equal(e.fx_rate,7.1);assert.equal(d.accounts[0].balance_cents,-8000);assert.equal(d.accounts[1].balance_cents,10000);assert.equal(d.entries.find(x=>x.id===a.body.id).category,'待分类');
 // "采购" and "纸箱" match different categories, so ambiguous suggestions require confirmation.
 const s=await request('/suggest',{description:'采购纸箱'});assert.equal(s.body.category,'待分类');
});
test('规则分类、冲突处理和手动分类覆盖',async()=>{
 assert.equal((await request('/suggest',{description:'买胶带'})).body.category,'包材');
 assert.equal((await request('/suggest',{description:'未知用途'})).body.category,'待分类');
 await request('/rules',{keyword:'快递',category:'运费物流'});
 assert.equal((await request('/suggest',{description:'快递费用'})).body.category,'运费物流');
 const r=await request('/entries',expense({description:'纸箱补货',category:'日常消耗品'}));assert.equal((await state()).entries.find(x=>x.id===r.body.id).category,'日常消耗品');
});
test('金额、币种、汇率、日期及账户在服务端校验',async()=>{
 for(const change of [{amount:'0'},{amount:'-1'},{amount:'1.001'},{currency:'EUR'},{account_id:2},{date:'2026-02-30'},{currency:'USD',account_id:2,fx_rate:0},{amount:'abc'}]) assert.equal((await request('/entries',expense(change))).status,400);
});
test('同币种备用金转账改变余额但不生成支出；跨币种和同账户转账被拒绝',async()=>{
 const before=await state();const count=before.entries.filter(x=>x.type==='expense').length;
 const r=await request('/entries',expense({type:'transfer',amount:'500',description:'拨付备用金',to_account_id:3}));assert.equal(r.status,201);
 const after=await state();assert.equal(after.accounts[2].balance_cents,50000);assert.equal(after.accounts[0].balance_cents,before.accounts[0].balance_cents-50000);assert.equal(after.entries.filter(x=>x.type==='expense').length,count);
 assert.equal((await request('/entries',expense({type:'transfer',to_account_id:2}))).status,400);
 assert.equal((await request('/entries',expense({type:'transfer',to_account_id:1}))).status,400);
});
test('员工垫付只记一次费用，偿还仅扣资金；重复偿还及修改关联记录被拒绝',async()=>{
 const before=await state();const r=await request('/entries',expense({amount:'125.50',description:'员工购买包材',category:'包材',paid_by:'employee',person:'李明'}));assert.equal(r.status,201);
 assert.equal((await state()).accounts[0].balance_cents,before.accounts[0].balance_cents);
 const pay={date:'2026-10-13',account_id:1,fx_rate:1};assert.equal((await request(`/entries/${r.body.id}/reimburse`,pay)).status,200);
 const after=await state();assert.equal(after.accounts[0].balance_cents,before.accounts[0].balance_cents-12550);assert.equal(after.entries.filter(x=>x.source_id===r.body.id).length,1);
 assert.equal((await request(`/entries/${r.body.id}/reimburse`,pay)).status,400);
 assert.equal((await request(`/entries/${r.body.id}`,expense(),'PUT')).status,400);
 assert.equal((await request(`/entries/${r.body.id}`,{},'DELETE')).status,400);
});
test('工资按当次时薪到分计算，支付幂等且关联流水受保护',async()=>{
 const r=await request('/payroll',{name:'Amy',date:'2026-10-12',hours:'3.25',rate:'22.50',currency:'USD',fx_rate:7.1});assert.equal(r.status,201);
 let d=await state();assert.equal(d.payroll.find(p=>p.id===r.body.id).amount_cents,7313);
 assert.equal((await request(`/payroll/${r.body.id}/pay`,{date:'2026-10-13',account_id:1,fx_rate:7.2})).status,400);
 const p=await request(`/payroll/${r.body.id}/pay`,{date:'2026-10-13',account_id:2,fx_rate:7.2});assert.equal(p.status,200);
 assert.equal((await request(`/payroll/${r.body.id}/pay`,{date:'2026-10-13',account_id:2,fx_rate:7.2})).status,400);
 d=await state();assert.equal(d.entries.filter(e=>e.payroll_id===r.body.id).length,1);assert.equal(d.payroll.find(x=>x.id===r.body.id).entry_id,p.body.id);
 assert.equal((await request(`/entries/${p.body.id}`,{},'DELETE')).status,400);
 assert.equal((await request(`/payroll/${r.body.id}`,{},'DELETE')).status,400);
 assert.equal((await request('/payroll',{name:'Test',date:'2026-10-12',hours:25,rate:5,currency:'CNY',fx_rate:1})).status,400);
});
test('普通流水修改及删除，保留审计日志',async()=>{
 const r=await request('/entries',expense({description:'测试修改'}));const id=r.body.id;
 assert.equal((await request('/entries/'+id,expense({amount:'9.99',description:'改后记录',category:'包材'}),'PUT')).status,200);
 assert.equal((await state()).entries.find(x=>x.id===id).amount_cents,999);
 assert.equal((await request('/entries/'+id,{},'DELETE')).status,200);
 assert.equal((await state()).entries.some(x=>x.id===id),false);
 assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE entity_id=? AND entity='entry'").get(id).n,3);
});
test('重复流水必须显式确认',async()=>{
 assert.equal((await request('/entries',expense())).status,409);
 assert.equal((await request('/entries',expense({allow_duplicate:true}))).status,201);
});
test('CSV预览不写入，非法和重复行整批拒绝，成功整批导入',async()=>{
 const header=['日期','类型','金额','币种','说明','分类','账户','汇率'];
 const rows=parseCSV(toCSV([header,['2026-09-01','支出','10.25','CNY','纸箱,带盖','包材','人民币银行账户','1'],['2026-09-02','收入','200','USD','Whatnot九月到账','Whatnot到账','美元收款账户','7.2']]));
 const before=(await state()).entries.length;
 assert.equal((await request('/import/preview',{rows})).body.entries.length,2);assert.equal((await state()).entries.length,before);
 assert.equal((await request('/import',{rows:[...rows,{...rows[1],amount:'-1'}]})).status,400);assert.equal((await state()).entries.length,before);
 assert.equal((await request('/import',{rows:[rows[0],rows[0]]})).status,400);
 assert.equal((await request('/import',{rows})).body.count,2);
 assert.equal((await request('/import',{rows})).status,400);assert.equal((await state()).entries.length,before+2);
});
test('CSV导出与筛选对应、特殊字符正确转义并防止公式执行',async()=>{
 const r=await fetch(base+'/api/export?month=2026-09&currency=USD&type=income&category='+encodeURIComponent('Whatnot到账'));
 const s=await r.text();assert.ok(s.includes('Whatnot九月到账'));assert.ok(!s.includes('纸箱,带盖'));assert.ok(s.includes('1440.00'));
 assert.ok(toCSV([['=HYPERLINK("x")']]).includes("'=HYPERLINK"));
 assert.throws(()=>parseCSV('日期,金额\n2026-01-01,10'));
 assert.throws(()=>parseCSV('"未闭合'));
});
test('期初余额独立于收入；一致性备份可打开并还原流水',async()=>{
 const r=await request('/accounts',{name:'支付宝',currency:'CNY',opening:'1000.50'});assert.equal(r.status,200);const d=await state();assert.equal(d.accounts.find(a=>a.id===r.body.id).balance_cents,100050);
 const res=await fetch(base+'/api/backup');assert.equal(res.status,200);const {writeFile}=await import('node:fs/promises');const path=join(dir,'restore.sqlite');await writeFile(path,Buffer.from(await res.arrayBuffer()));const restore=new DatabaseSync(path);assert.equal(restore.prepare('SELECT count(*) n FROM entries').get().n,d.entries.length);restore.close();
});
