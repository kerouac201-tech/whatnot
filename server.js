import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categories, types, toCSV } from './src/shared.js';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || resolve(root, 'data/ledger.sqlite');
mkdirSync(dirname(dbPath), {recursive:true});
export const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,currency TEXT NOT NULL,opening_cents INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY,keyword TEXT NOT NULL UNIQUE,category TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY,date TEXT NOT NULL,type TEXT NOT NULL,amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,fx_rate REAL NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,account_id INTEGER REFERENCES accounts(id),to_account_id INTEGER REFERENCES accounts(id),paid_by TEXT NOT NULL DEFAULT 'company',person TEXT NOT NULL DEFAULT '',source_id INTEGER REFERENCES entries(id),payroll_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS payroll (id INTEGER PRIMARY KEY,name TEXT NOT NULL,date TEXT NOT NULL,hours REAL NOT NULL,rate_cents INTEGER NOT NULL,amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,fx_rate REAL NOT NULL,entry_id INTEGER REFERENCES entries(id));
 CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY,action TEXT NOT NULL,entity TEXT NOT NULL,entity_id INTEGER,data TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
if (!db.prepare('SELECT count(*) n FROM settings').get().n) {
  db.prepare('INSERT INTO settings VALUES (?,?)').run('fx_rate','7.20');
  db.prepare('INSERT INTO settings VALUES (?,?)').run('timezone','America/Los_Angeles');
  const stmt=db.prepare('INSERT INTO accounts(name,currency) VALUES (?,?)');
  stmt.run('人民币银行账户','CNY'); stmt.run('美元收款账户','USD'); stmt.run('人民币备用金','CNY');
  const rule=db.prepare('INSERT INTO rules(keyword,category) VALUES (?,?)');
  for(const [k,c] of [['纸箱','包材'],['胶带','包材'],['气泡袋','包材'],['房租','行政运营'],['水电','行政运营'],['清洁','日常消耗品'],['采购','货品采购'],['运费','运费物流'],['佣金','人员佣金'],['工资','主播工资'],['Whatnot','Whatnot到账']]) rule.run(k,c);
}
const bad=(message)=> { const e=new Error(message); e.status=400; throw e; };
const validCurrency=c=> { if(!['CNY','USD'].includes(c)) bad('仅支持人民币和美元'); return c; };
const validDate=s=> { if(!/^\d{4}-\d{2}-\d{2}$/.test(s||'')||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s) bad('请输入有效日期'); return s; };
const str=(v,label,max=200)=> { if(typeof v!=='string'||!v.trim()||v.length>max) bad(`${label}不能为空且不能超过 ${max} 字`); return v.trim(); };
const cents=v=> { if(!/^\d+(\.\d{1,2})?$/.test(String(v))) bad('金额必须为正数，最多两位小数'); const n=Math.round(Number(v)*100); if(!Number.isSafeInteger(n)||n<=0||n>100000000000) bad('金额超出范围'); return n; };
const fx=(v,c)=> { if(c==='CNY') return 1; const n=Number(v); if(!Number.isFinite(n)||n<=0||n>1000) bad('请确认有效的美元折算汇率'); return n; };
const account=(id,c)=> { const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(id)||0); if(!a||a.currency!==c) bad('请选择同币种的账户'); return a; };
function audit(action,entity,id,data) { db.prepare('INSERT INTO audit(action,entity,entity_id,data) VALUES (?,?,?,?)').run(action,entity,id,JSON.stringify(data)); }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try {const result=fn(); db.exec('COMMIT'); return result;} catch(e){db.exec('ROLLBACK');throw e;} }
function suggest(description) {
 const matches=db.prepare('SELECT * FROM rules ORDER BY id DESC').all().filter(r=>description.toLowerCase().includes(r.keyword.toLowerCase()));
 const cs=[...new Set(matches.map(r=>r.category))];
 return {category:cs.length===1?cs[0]:'待分类',reason:cs.length===1?`匹配关键词：${matches.map(r=>r.keyword).join('、')}`:cs.length>1?'匹配多个分类，请确认':'未匹配规则，请选择分类'};
}
function normalize(b) {
 if(!['income','expense','transfer'].includes(b.type)) bad('不支持此记账类型');
 const currency=validCurrency(b.currency), amount_cents=cents(b.amount), date=validDate(b.date), description=str(b.description,'说明');
 const fx_rate=fx(b.fx_rate,currency);
 const paid_by=b.type==='expense'&&b.paid_by==='employee'?'employee':'company';
 const person=paid_by==='employee'?str(b.person,'垫付人',60):'';
 const account_id=paid_by==='employee'?null:account(b.account_id,currency).id;
 let to_account_id=null;
 if(b.type==='transfer') { to_account_id=account(b.to_account_id,currency).id; if(account_id===to_account_id) bad('转出和转入账户不能相同'); }
 const category=b.type==='transfer'?'内部转账':b.category||suggest(description).category;
 if(b.type!=='transfer'&&!categories.includes(category)) bad('分类无效');
 if(category==='老板注资'&&b.type!=='income'||category==='老板提款'&&b.type!=='expense') bad('注资应记收入，提款应记支出');
 return {date,type:b.type,amount_cents,currency,fx_rate,description,category,account_id,to_account_id,paid_by,person};
}
function duplicate(e) { return db.prepare('SELECT id FROM entries WHERE date=? AND type=? AND amount_cents=? AND currency=? AND description=? AND account_id IS ? AND paid_by=? LIMIT 1').get(e.date,e.type,e.amount_cents,e.currency,e.description,e.account_id,e.paid_by); }
function insert(e) {
 const keys=['date','type','amount_cents','currency','fx_rate','description','category','account_id','to_account_id','paid_by','person','source_id','payroll_id'];
 const id=Number(db.prepare(`INSERT INTO entries(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>e[k]??null)).lastInsertRowid);
 audit('create','entry',id,e); return id;
}
export const app=express();
app.use(express.json({limit:'2mb'}));
app.use('/api',(_req,res,next)=> {res.set('Cache-Control','no-store');next();});
app.get('/api/state',(_req,res)=> {
 const entries=db.prepare(`SELECT e.*,a.name account_name,t.name to_account_name,(SELECT id FROM entries r WHERE r.source_id=e.id) reimbursement_id FROM entries e LEFT JOIN accounts a ON e.account_id=a.id LEFT JOIN accounts t ON e.to_account_id=t.id ORDER BY e.date DESC,e.id DESC`).all();
 const accounts=db.prepare('SELECT * FROM accounts ORDER BY id').all().map(a=> ({...a,balance_cents:a.opening_cents+entries.reduce((n,e)=>n+(e.to_account_id===a.id?e.amount_cents:0)+(e.account_id===a.id?(e.type==='income'?e.amount_cents:-e.amount_cents):0),0)}));
 res.json({entries,accounts,rules:db.prepare('SELECT * FROM rules ORDER BY id DESC').all(),payroll:db.prepare('SELECT * FROM payroll ORDER BY date DESC,id DESC').all(),settings:Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(x=>[x.key,x.value])),categories});
});
app.post('/api/suggest',(req,res)=>res.json(suggest(String(req.body.description||''))));
app.post('/api/entries',(req,res)=> {
 const e=normalize(req.body);
 if(duplicate(e)&&!req.body.allow_duplicate) return res.status(409).json({error:'发现可能重复的流水，请确认是否仍要保存',duplicate:true});
 res.status(201).json({id:transaction(()=>insert(e))});
});
app.put('/api/entries/:id',(req,res)=> {
 const old=db.prepare('SELECT * FROM entries WHERE id=?').get(Number(req.params.id)); if(!old) bad('记录不存在');
 if(old.type==='reimbursement'||old.payroll_id||db.prepare('SELECT id FROM entries WHERE source_id=?').get(old.id)) bad('已关联工资或偿还的流水不可直接修改');
 const e=normalize(req.body);
 transaction(()=>{const keys=Object.keys(e);db.prepare(`UPDATE entries SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`).run(...Object.values(e),old.id);audit('update','entry',old.id,{before:old,after:e});});
 res.json({ok:true});
});
app.delete('/api/entries/:id',(req,res)=> {
 const old=db.prepare('SELECT * FROM entries WHERE id=?').get(Number(req.params.id));if(!old) bad('记录不存在');
 if(old.type==='reimbursement'||old.payroll_id||db.prepare('SELECT id FROM entries WHERE source_id=?').get(old.id)) bad('已关联工资或偿还的流水不可直接删除');
 transaction(()=>{db.prepare('DELETE FROM entries WHERE id=?').run(old.id);audit('delete','entry',old.id,old);});res.json({ok:true});
});
app.post('/api/entries/:id/reimburse',(req,res)=> {
 const old=db.prepare('SELECT * FROM entries WHERE id=?').get(Number(req.params.id));
 if(!old||old.type!=='expense'||old.paid_by!=='employee') bad('此记录不是员工垫付');
 const id=transaction(()=> {
  if(db.prepare('SELECT id FROM entries WHERE source_id=?').get(old.id)) bad('该笔垫付已偿还');
  return insert({date:validDate(req.body.date),type:'reimbursement',amount_cents:old.amount_cents,currency:old.currency,fx_rate:fx(req.body.fx_rate,old.currency),description:`偿还 ${old.person}：${old.description}`,category:'垫付偿还',account_id:account(req.body.account_id,old.currency).id,to_account_id:null,paid_by:'company',person:old.person,source_id:old.id});
 });res.json({id});
});
function importRows(rows) {
 if(!Array.isArray(rows)||!rows.length||rows.length>2000) bad('每次导入 1–2000 行');
 const seen=new Set();
 return rows.map((r,i)=>{
  try {
   if(!['income','expense'].includes(r.type)) bad('导入仅支持普通收入和支出');
   const a=db.prepare('SELECT * FROM accounts WHERE name=?').get(String(r.account_name));
   const e=normalize({...r,account_id:a?.id});
   const key=JSON.stringify([e.date,e.type,e.amount_cents,e.currency,e.description,e.account_id]);
   if(seen.has(key)||duplicate(e)) bad('发现重复流水');seen.add(key);return e;
  }catch(err){bad(`第 ${i+2} 行：${err.message}`);}
 });
}
app.post('/api/import/preview',(req,res)=>res.json({entries:importRows(req.body.rows)}));
app.post('/api/import',(req,res)=> {
 const ids=transaction(()=>importRows(req.body.rows).map(insert));res.json({count:ids.length});
});
app.get('/api/export',(req,res)=> {
 const all=db.prepare(`SELECT e.*,a.name account_name,t.name to_account_name FROM entries e LEFT JOIN accounts a ON e.account_id=a.id LEFT JOIN accounts t ON e.to_account_id=t.id ORDER BY date DESC,id DESC`).all();
 const entries=all.filter(e=>(!req.query.month||e.date.startsWith(String(req.query.month)))&&(!req.query.currency||e.currency===req.query.currency)&&(!req.query.category||e.category===req.query.category)&&(!req.query.type||e.type===req.query.type)&&(!req.query.search||[e.description,e.person,e.category].some(v=>v.toLowerCase().includes(String(req.query.search).toLowerCase()))));
 res.type('text/csv').attachment('whatnot-ledger.csv').send(toCSV([['日期','类型','金额','币种','说明','分类','账户','汇率','人民币折算','付款方式','垫付人','转入账户'],...entries.map(e=>[e.date,types[e.type],(e.amount_cents/100).toFixed(2),e.currency,e.description,e.category,e.account_name||'',e.fx_rate,(Math.round(e.amount_cents*e.fx_rate)/100).toFixed(2),e.paid_by==='employee'?'员工垫付':'公司账户',e.person,e.to_account_name||''])]));
});
app.post('/api/payroll',(req,res)=> {
 const b=req.body,name=str(b.name,'主播姓名',60),date=validDate(b.date),hours=Number(b.hours),rate_cents=cents(b.rate),currency=validCurrency(b.currency),fx_rate=fx(b.fx_rate,currency);
 if(!Number.isFinite(hours)||hours<=0||hours>24||!/^\d+(\.\d{1,2})?$/.test(String(b.hours))) bad('每日工时应在 0–24 小时内，最多两位小数');
 const amount_cents=Math.round(Math.round(hours*100)*rate_cents/100);
 if(!amount_cents||amount_cents>100000000000) bad('工资金额超出范围');
 const id=transaction(()=> {const id=Number(db.prepare('INSERT INTO payroll(name,date,hours,rate_cents,amount_cents,currency,fx_rate) VALUES (?,?,?,?,?,?,?)').run(name,date,hours,rate_cents,amount_cents,currency,fx_rate).lastInsertRowid);audit('create','payroll',id,{name,date,hours,rate_cents,currency});return id;});res.status(201).json({id});
});
app.post('/api/payroll/:id/pay',(req,res)=> {
 const id=transaction(()=> {
  const p=db.prepare('SELECT * FROM payroll WHERE id=?').get(Number(req.params.id));if(!p||p.entry_id) bad('工时不存在或已支付');
  const id=insert({date:validDate(req.body.date),type:'expense',amount_cents:p.amount_cents,currency:p.currency,fx_rate:fx(req.body.fx_rate,p.currency),description:`${p.name} 主播工资 · ${p.date} · ${p.hours}小时`,category:'主播工资',account_id:account(req.body.account_id,p.currency).id,to_account_id:null,paid_by:'company',person:p.name,payroll_id:p.id});
  db.prepare('UPDATE payroll SET entry_id=? WHERE id=?').run(id,p.id);audit('pay','payroll',p.id,{entry_id:id});return id;
 });res.json({id});
});
app.delete('/api/payroll/:id',(req,res)=> {
 const p=db.prepare('SELECT * FROM payroll WHERE id=?').get(Number(req.params.id));if(!p||p.entry_id) bad('已支付工资不可删除');
 transaction(()=>{db.prepare('DELETE FROM payroll WHERE id=?').run(p.id);audit('delete','payroll',p.id,p);});res.json({ok:true});
});
app.put('/api/settings',(req,res)=> {
 const rate=fx(req.body.fx_rate,'USD'),zone=str(req.body.timezone,'时区',80);try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{bad('时区无效，请使用如 America/Los_Angeles 的名称');}
 transaction(()=> {for(const [k,v] of [['fx_rate',rate],['timezone',zone]]) db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(k,String(v));audit('update','settings',null,{fx_rate:rate,timezone:zone});});res.json({ok:true});
});
app.post('/api/accounts',(req,res)=> {
 const name=str(req.body.name,'账户名称',60),currency=validCurrency(req.body.currency),v=Number(req.body.opening||0);
 if(!Number.isFinite(v)||Math.abs(v)>1000000000||!/^[-]?\d+(\.\d{1,2})?$/.test(String(req.body.opening||0))) bad('期初余额无效');
 const id=transaction(()=>{const id=Number(db.prepare('INSERT INTO accounts(name,currency,opening_cents) VALUES (?,?,?)').run(name,currency,Math.round(v*100)).lastInsertRowid);audit('create','account',id,{name,currency,opening_cents:Math.round(v*100)});return id;});res.json({id});
});
app.post('/api/rules',(req,res)=> {
 const keyword=str(req.body.keyword,'关键词',60),category=req.body.category;if(!categories.includes(category)) bad('分类无效');
 transaction(()=>{db.prepare('INSERT INTO rules(keyword,category) VALUES (?,?) ON CONFLICT(keyword) DO UPDATE SET category=excluded.category').run(keyword,category);audit('save','rule',null,{keyword,category});});res.json({ok:true});
});
app.delete('/api/rules/:id',(req,res)=> {transaction(()=>{db.prepare('DELETE FROM rules WHERE id=?').run(Number(req.params.id));audit('delete','rule',Number(req.params.id),{});});res.json({ok:true});});
app.get('/api/backup',(_req,res)=> {
 const path=resolve(dirname(dbPath),'snapshot-'+Date.now()+'.sqlite');
 db.prepare('VACUUM INTO ?').run(path);
 res.download(path,'whatnot-backup.sqlite',async()=>{const {unlink}=await import('node:fs/promises');await unlink(path).catch(()=>{});});
});
app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在'}));
app.use((err,_req,res,_next)=> {const message=String(err.message||'');if(message.includes('UNIQUE constraint')) return res.status(400).json({error:'名称已存在，请使用其他名称'});res.status(err.status||500).json({error:err.status?message:'操作失败，请检查服务器日志'});if(!err.status) console.error(err);});
export async function start() {
 if(process.env.NODE_ENV==='production') {app.use(express.static(resolve(root,'dist')));app.get('/{*path}',(_req,res)=>res.sendFile(resolve(root,'dist/index.html')));}
 else { const {createServer}=await import('vite');const vite=await createServer({root,server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
 const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
 return app.listen(port,host,()=>console.log(`拾账已启动，端口 ${port}。数据库：${dbPath}`));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) await start();
