export const categories = ['Whatnot到账','其他经营收入','货品采购','行政运营','主播工资','人员佣金','日常消耗品','包材','运费物流','平台费用','售后支出','老板注资','老板提款','待分类'];
export const types = { income:'收入', expense:'支出', transfer:'内部转账', reimbursement:'垫付偿还' };
export const money = (cents, currency='CNY') => new Intl.NumberFormat('zh-CN', {style:'currency', currency}).format(cents / 100);
export function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i=0;i<text.length;i++) {
    const c = text[i];
    if (c==='"') {
      if (quoted && text[i+1]==='"') { cell+='"'; i++; }
      else if (!quoted && cell) throw new Error('CSV 引号格式错误');
      else quoted=!quoted;
    } else if (c===',' && !quoted) { row.push(cell); cell=''; }
    else if ((c==='\n'||c==='\r') && !quoted) {
      if(c==='\r'&&text[i+1]==='\n') i++;
      row.push(cell); if(row.some(v=>v.trim())) rows.push(row); row=[]; cell='';
    } else cell+=c;
  }
  if(quoted) throw new Error('CSV 引号未闭合');
  row.push(cell); if(row.some(v=>v.trim())) rows.push(row);
  if(!rows.length) throw new Error('CSV 为空');
  const header=rows.shift().map(v=>v.trim());
  const expected=['日期','类型','金额','币种','说明','分类','账户','汇率'];
  if(expected.some((v,i)=>header[i]!==v)||header.length!==8) throw new Error('请使用标准的八列导入模板');
  return rows.map((r,i)=> {
    if(r.length!==8) throw new Error(`第 ${i+2} 行列数错误`);
    const [date,type,amount,currency,description,category,account_name,fx_rate]=r.map(v=>v.trim());
    return {date,type:({'收入':'income','支出':'expense'})[type]||type,amount,currency,description,category,account_name,fx_rate};
  });
}
export function toCSV(rows) {
  return '\uFEFF' + rows.map(row=>row.map(value=> {
    let s=String(value??'');
    // Prevent spreadsheet formula execution for user-controlled text.
    if (/^[=+@\-\t\r]/.test(s)) s="'"+s;
    return '"'+s.replaceAll('"','""')+'"';
  }).join(',')).join('\r\n');
}
