interface Env {
  DB: D1Database;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    if (path === '/api/upload/asset')   return handleAssetUpload(request, env);
    if (path === '/api/upload/penalty') return handlePenaltyUpload(request, env);
    if (path === '/api/upload/revenue') return handleRevenueUpload(request, env);
    return json({ error: 'Unknown upload route' }, 404);
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
};

async function handleAssetUpload(request: Request, env: Env) {
  const { rows: dataRows, header, error } = await parseRequest(request);
  if (error) return json({ error }, 400);

  const idx = {
    district:  findCol(header, ['district name','district']),
    hospital:  findCol(header, ['hospital name','hospital']),
    equipment: findCol(header, ['equipment name','equipment']),
    qr_code:   findCol(header, ['qr code','qrcode','qr']),
    asset_val: findCol(header, ['asset value','value']),
  };
  const miss = missingCols(idx);
  if (miss) return json({ error: `Missing columns: ${miss}` }, 400);

  const existingRes: any = await env.DB.prepare('SELECT qr_code FROM asset_report').all();
  const existingQRs = new Set((existingRes.results || []).map((r: any) => r.qr_code));

  const successLog: any[] = [], failLog: any[] = [];
  const stmts: any[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2;
    if (!row || row.length < 2) continue;

    const qr = (row[idx.qr_code] || '').trim();
    if (!qr || qr.startsWith('--')) {
      failLog.push({ row: rowNum, id: qr || '(empty)', reason: 'Skipped — empty or starts with --' });
      continue;
    }

    stmts.push({
      rowNum,
      qr,
      isNew:     !existingQRs.has(qr),
      district:  (row[idx.district]  || '').trim(),
      hospital:  (row[idx.hospital]   || '').trim(),
      equipment: (row[idx.equipment]  || '').trim(),
      assetVal:  parseNum(row[idx.asset_val]),
    });
  }

  const D1_LIMIT = 1000;
  let inserted = 0, updated = 0;

  for (let i = 0; i < stmts.length; i += D1_LIMIT) {
    const chunk = stmts.slice(i, i + D1_LIMIT);
    const prepared = chunk.map(s =>
      env.DB.prepare(`
        INSERT INTO asset_report (district_name, hospital_name, equipment_name, qr_code, asset_value)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(qr_code) DO UPDATE SET
          district_name  = excluded.district_name,
          hospital_name  = excluded.hospital_name,
          equipment_name = excluded.equipment_name,
          asset_value    = excluded.asset_value,
          updated_at     = datetime('now')
      `).bind(s.district, s.hospital, s.equipment, s.qr, s.assetVal)
    );
    const results = await env.DB.batch(prepared);
    results.forEach((res, j) => {
      const s = chunk[j];
      if (res.meta && res.meta.changes > 0) {
        if (s.isNew) { inserted++; successLog.push({ row: s.rowNum, id: s.qr, status: 'Inserted' }); }
        else         { updated++;  successLog.push({ row: s.rowNum, id: s.qr, status: 'Updated' }); }
      } else {
        successLog.push({ row: s.rowNum, id: s.qr, status: 'No change' });
      }
    });
  }

  return json({ success: true, inserted, updated, skipped: failLog.length, errors: 0, successLog, failLog }, 200);
}

async function handlePenaltyUpload(request: Request, env: Env) {
  const { rows: dataRows, header, error } = await parseRequest(request);
  if (error) return json({ error }, 400);

  const idx = {
    district:       findCol(header, ['district name','district']),
    hospital_type:  findCol(header, ['hospital type']),
    hospital:       findCol(header, ['hospital name','hospital']),
    bar_code:       findCol(header, ['bar code','barcode']),
    equipment:      findCol(header, ['equipment name','equipment']),
    complaint_id:   findCol(header, ['complaint id','complaint_id']),
    raise_date:     findCol(header, ['complaint raise date','raise date']),
    close_date:     findCol(header, ['complaint close date','close date']),
    status:         findCol(header, ['complaint status','status']),
    attend_date:    findCol(header, ['attend date']),
    attend_penalty: findCol(header, ['attend penalty']),
    penalty:        findCol(header, ['penalty']),
    total_penalty:  findCol(header, ['total penalty']),
    attend_eng_id:  findCol(header, ['attend engineer id','attend engineer']),
    close_eng_id:   findCol(header, ['close engineer id','close engineer']),
    open_month:     findCol(header, ['open month']),
    close_month:    findCol(header, ['close month']),
  };
  const miss = missingCols(idx);
  if (miss) return json({ error: `Missing columns: ${miss}` }, 400);

  const existingRes: any = await env.DB.prepare('SELECT complaint_id FROM penalty_report').all();
  const existingIds = new Set((existingRes.results || []).map((r: any) => r.complaint_id));

  const successLog: any[] = [], failLog: any[] = [];
  const stmts: any[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2;
    if (!row || row.length < 2) continue;

    const cid = (row[idx.complaint_id] || '').trim();
    if (!cid || cid.startsWith('--')) {
      failLog.push({ row: rowNum, id: cid || '(empty)', reason: 'Skipped — empty or starts with --' });
      continue;
    }

    stmts.push({
      rowNum, cid,
      isNew: !existingIds.has(cid),
      binds: [
        (row[idx.district]       || '').trim(),
        (row[idx.hospital_type]  || '').trim(),
        (row[idx.hospital]       || '').trim(),
        (row[idx.bar_code]       || '').trim(),
        (row[idx.equipment]      || '').trim(),
        cid,
        cleanDate(row[idx.raise_date]),
        cleanDate(row[idx.close_date]),
        (row[idx.status]         || '').trim(),
        cleanDate(row[idx.attend_date]),
        parseNum(row[idx.attend_penalty]),
        parseNum(row[idx.penalty]),
        parseNum(row[idx.total_penalty]),
        (row[idx.attend_eng_id]  || '').trim(),
        (row[idx.close_eng_id]   || '').trim(),
        (row[idx.open_month]     || '').trim(),
        (row[idx.close_month]    || '').trim(),
      ]
    });
  }

  const D1_LIMIT = 1000;
  let inserted = 0, updated = 0;

  for (let i = 0; i < stmts.length; i += D1_LIMIT) {
    const chunk = stmts.slice(i, i + D1_LIMIT);
    const prepared = chunk.map(s =>
      env.DB.prepare(`
        INSERT INTO penalty_report (
          district_name, hospital_type, hospital_name, bar_code,
          equipment_name, complaint_id, complaint_raise_date,
          complaint_close_date, complaint_status, attend_date,
          attend_penalty, penalty, total_penalty,
          attend_engineer_id, close_engineer_id, open_month, close_month
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(complaint_id) DO UPDATE SET
          complaint_close_date = excluded.complaint_close_date,
          complaint_status     = excluded.complaint_status,
          attend_date          = excluded.attend_date,
          attend_penalty       = excluded.attend_penalty,
          penalty              = excluded.penalty,
          total_penalty        = excluded.total_penalty,
          attend_engineer_id   = excluded.attend_engineer_id,
          close_engineer_id    = excluded.close_engineer_id,
          open_month           = excluded.open_month,
          close_month          = excluded.close_month,
          updated_at           = datetime('now')
      `).bind(...s.binds)
    );
    const results = await env.DB.batch(prepared);
    results.forEach((res, j) => {
      const s = chunk[j];
      if (res.meta && res.meta.changes > 0) {
        if (s.isNew) { inserted++; successLog.push({ row: s.rowNum, id: s.cid, status: 'Inserted' }); }
        else         { updated++;  successLog.push({ row: s.rowNum, id: s.cid, status: 'Updated' }); }
      } else {
        failLog.push({ row: s.rowNum, id: s.cid, reason: 'No changes detected' });
      }
    });
  }

  return json({ success: true, inserted, updated, skipped: failLog.length, errors: 0, successLog, failLog }, 200);
}

async function handleRevenueUpload(request: Request, env: Env) {
  const { rows: dataRows, header, error } = await parseRequest(request);
  if (error) return json({ error }, 400);

  const idx = {
    district:          findCol(header, ['district name','district']),
    dm_name:           findCol(header, ['dm name','dm']),
    facility_type:     findCol(header, ['facility type','facility']),
    di_name:           findCol(header, ['di name','di']),
    billing_amount:    findCol(header, ['billing amount','billing']),
    open_penalty_feb:  findCol(header, ['open penalty feb','open penalty']),
    purchase:          findCol(header, ['purchase (spare + service)','purchase']),
    camc:              findCol(header, ['camc']),
    total_ppc:         findCol(header, ['total(penalty+purchase+camc)','total']),
    rm_achieved:       findCol(header, ['r/m achieved %','r/m achieved','rm achieved']),
    rm_target:         findCol(header, ['r & m traget','r & m target','rm target']),
    eligibility_month: findCol(header, ['eligibility month','eligibility']),
  };
  const miss = missingCols(idx);
  if (miss) return json({ error: `Missing columns: ${miss}` }, 400);

  const existingRes: any = await env.DB.prepare(
    'SELECT di_name, eligibility_month FROM revenue_report'
  ).all();
  const existingKeys = new Set(
    (existingRes.results || []).map((r: any) => `${r.di_name}||${r.eligibility_month}`)
  );

  const successLog: any[] = [], failLog: any[] = [];
  const stmts: any[] = [];
  const seenInBatch = new Set();

  for (let i = 0; i < dataRows.length; i++) {
    const row    = dataRows[i];
    const rowNum = i + 2;
    if (!row || row.length < 2) continue;

    const month    = (row[idx.eligibility_month] || '').trim();
    const di_name  = (row[idx.di_name]           || '').trim();
    const district = (row[idx.district]           || '').trim();

    if (!month || month.startsWith('--')) {
      failLog.push({ row: rowNum, id: month || '(empty)', reason: 'Skipped — empty or starts with --' });
      continue;
    }

    const compositeKey = `${di_name}||${month}`;
    if (seenInBatch.has(compositeKey)) {
      failLog.push({ row: rowNum, id: compositeKey, reason: `Duplicate in CSV — DI: ${di_name} / ${month} already in this file` });
      continue;
    }
    seenInBatch.add(compositeKey);

    stmts.push({
      rowNum, month, di_name, district,
      compositeKey,
      isNew: !existingKeys.has(compositeKey),
      binds: [
        district,
        (row[idx.dm_name]       || '').trim(),
        (row[idx.facility_type] || '').trim(),
        di_name,
        parseNum(row[idx.billing_amount]),
        parseNum(row[idx.open_penalty_feb]),
        parseNum(row[idx.purchase]),
        parseNum(row[idx.camc]),
        parseNum(row[idx.total_ppc]),
        parseNum(row[idx.rm_achieved]),
        parseNum(row[idx.rm_target]),
        month,
      ]
    });
  }

  const D1_LIMIT = 1000;
  let inserted = 0, updated = 0;

  for (let i = 0; i < stmts.length; i += D1_LIMIT) {
    const chunk = stmts.slice(i, i + D1_LIMIT);
    const prepared = chunk.map(s =>
      env.DB.prepare(`
        INSERT INTO revenue_report (
          district_name, dm_name, facility_type, di_name,
          billing_amount, open_penalty_feb, purchase_spare_service,
          camc, total_penalty_purchase_camc, rm_achieved_pct,
          rm_target, eligibility_month
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(di_name, eligibility_month) DO UPDATE SET
          district_name               = excluded.district_name,
          dm_name                     = excluded.dm_name,
          facility_type               = excluded.facility_type,
          billing_amount              = excluded.billing_amount,
          open_penalty_feb            = excluded.open_penalty_feb,
          purchase_spare_service      = excluded.purchase_spare_service,
          camc                        = excluded.camc,
          total_penalty_purchase_camc = excluded.total_penalty_purchase_camc,
          rm_achieved_pct             = excluded.rm_achieved_pct,
          rm_target                   = excluded.rm_target,
          updated_at                  = datetime('now')
      `).bind(...s.binds)
    );
    const results = await env.DB.batch(prepared);
    results.forEach((res, j) => {
      const s = chunk[j];
      if (res.meta && res.meta.changes > 0) {
        if (s.isNew) { inserted++; successLog.push({ row: s.rowNum, id: s.compositeKey, status: 'Inserted' }); }
        else         { updated++;  successLog.push({ row: s.rowNum, id: s.compositeKey, status: 'Updated' }); }
      } else {
        successLog.push({ row: s.rowNum, id: s.compositeKey, status: 'No change' });
      }
    });
  }

  return json({ success: true, inserted, updated, skipped: failLog.length, errors: 0, successLog, failLog }, 200);
}

// Helper methods for parsing
async function parseRequest(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file') as File;
  if (!file) return { error: 'No file provided' };
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) return { error: 'CSV has no data rows' };
  const header = rows[0].map(h => h.trim().toLowerCase());
  return { rows: rows.slice(1), header };
}

function missingCols(idx: Record<string, number>) {
  const miss = Object.entries(idx).filter(([, v]) => v === -1).map(([k]) => k.replace(/_/g, ' '));
  return miss.length ? miss.join(', ') : null;
}

function findCol(headers: string[], candidates: string[]) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h === c || h.replace(/\s+/g, ' ').trim() === c);
    if (i !== -1) return i;
  }
  return -1;
}

function parseCSV(text: string) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  return lines.map(line => {
    const result = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    result.push(cur.trim());
    return result;
  });
}

function cleanDate(val: string) {
  if (!val) return null;
  const v = val.trim();
  return (!v || v === '-' || v === 'N/A') ? null : v;
}

function parseNum(val: any) {
  const n = parseFloat((val + '').replace(/[,%]/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
