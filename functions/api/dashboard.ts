interface Env {
  DB: D1Database;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const CACHE_HEADERS = {
  'Cache-Control': 'private, max-age=30, stale-while-revalidate=60',
  'X-Content-Type-Options': 'nosniff'
};

let cachedFacTable: string | null = null;

function isMissing(v: any) {
  return v === null || v === undefined || ['', 'null', 'undefined'].includes(String(v).trim().toLowerCase());
}

function getCookieValue(header: string | null, key: string) {
  const m = header ? header.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)) : null;
  return m ? decodeURIComponent(m[1]) : null;
}

function decodeJwtPayload(token: string) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
  } catch { return null; }
}

async function resolveUserId(request: Request, url: URL) {
  const candidates = [url.searchParams.get('user_id'), request.headers.get('x-user-id'), request.headers.get('x-userid')];
  candidates.push(getCookieValue(request.headers.get('cookie') || '', 'user_id'));
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const payload = decodeJwtPayload(auth.slice(7));
    if (payload) candidates.push(payload.user_id, payload.uid, payload.sub);
  }
  const id = candidates.find(v => !isMissing(v));
  return isMissing(id) ? null : String(id).trim();
}

function safeStringify(data: any) {
  return JSON.stringify(data, (key, value) => typeof value === 'bigint' ? Number(value) : value);
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const headers = { ...corsHeaders, 'Content-Type': 'application/json', ...CACHE_HEADERS };

  if (method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    if (!env.DB) {
      return new Response(safeStringify({ success: false, message: 'Database binding missing.' }), { status: 500, headers });
    }

    const userId = await resolveUserId(request, url);
    if (!userId) {
      return new Response(safeStringify({ success: false, message: 'Unauthorized.' }), { status: 401, headers });
    }

    const user: any = await env.DB.prepare(`SELECT user_id, full_name, role, e_upkaran_id, zone_name, district_name FROM user WHERE user_id = ?`).bind(userId).first();
    if (!user) {
      return new Response(safeStringify({ success: false, message: 'User not found.' }), { status: 403, headers });
    }

    const role = (user.role || '').trim();
    const userName = user.full_name || '';
    const isAdmin = role === 'Admin' || role === 'Superadmin';
    const isCoordinator = role === 'Coordinator';
    const isDM = role === 'Divisional Manager' || role === 'DM';
    const isDI = role === 'District Incharge' || role === 'DI';
    const isManager = role === 'Manager';

    if (!cachedFacTable) {
      try {
        await env.DB.prepare(`SELECT 1 FROM "Facily Details" LIMIT 1`).first();
        cachedFacTable = '"Facily Details"';
      } catch {
        cachedFacTable = 'facility_details';
      }
    }

    // ── FILTERS API ──
    if (path.endsWith('/filters') && method === 'GET') {
      const [usersRes, facRes] = await Promise.all([
        env.DB.prepare(`SELECT user_id, full_name, role, zone_name, district_name FROM user`).all(),
        env.DB.prepare(`SELECT DISTINCT facility_name, facility_incharge, district_name, zone_name, dm_name, coordinator_name FROM ${cachedFacTable}`).all()
      ]);
      return new Response(safeStringify({ success: true, users: usersRes.results || [], facilities: facRes.results || [] }), { status: 200, headers });
    }

    const filters = {
      startDate: url.searchParams.get('start_date'),
      endDate:   url.searchParams.get('end_date'),
      status:    url.searchParams.get('status')   || 'All',
      zone:      url.searchParams.get('zone')     || 'All',
      district:  url.searchParams.get('district') || 'All',
      manager:   url.searchParams.get('manager')  || 'All',
      engineer:  url.searchParams.get('engineer') || 'All',
      facility:  url.searchParams.get('facility') || 'All'
    };

    // ── PENALTIES API ──
    if (path.endsWith('/penalties') && method === 'GET') {
      let conds = ['1=1'];
      let params: any[] = [];
      
      if (!isAdmin) {
        if (isCoordinator) { conds.push(`f.coordinator_name = ?`); params.push(userName); }
        else if (isDM)     { conds.push(`f.dm_name = ?`); params.push(userName); }
        else if (isDI)     { conds.push(`f.district_name = ?`); params.push(user.district_name); }
        else if (isManager){ conds.push(`f.facility_incharge = ?`); params.push(userName); }
        else {
          const eId = user.e_upkaran_id || 'XXX';
          conds.push(`(p.attend_engineer_id = ? OR p.close_engineer_id = ?)`); params.push(eId, eId);
        }
      }
      if (filters.zone !== 'All') { conds.push(`f.zone_name = ?`); params.push(filters.zone); }
      if (filters.district !== 'All') { conds.push(`f.district_name = ?`); params.push(filters.district); }
      if (filters.facility !== 'All') { conds.push(`p.hospital_name = ?`); params.push(filters.facility); }
      if (filters.manager !== 'All') { conds.push(`f.facility_incharge = ?`); params.push(filters.manager); }
      if (filters.engineer !== 'All') { conds.push(`(p.attend_engineer_id = ? OR p.close_engineer_id = ?)`); params.push(filters.engineer, filters.engineer); }
      if (filters.startDate && filters.endDate) {
        const pd = `(SUBSTR(p.complaint_raise_date, 8, 4) || '-' || CASE SUBSTR(p.complaint_raise_date, 4, 3) WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04' WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08' WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12' END || '-' || SUBSTR(p.complaint_raise_date, 1, 2))`;
        conds.push(`(${pd} >= ? AND ${pd} <= ?)`);
        params.push(filters.startDate, filters.endDate);
      }

      const pWhere = conds.join(' AND ');

      try {
        let rawStmt = env.DB.prepare(`
          SELECT p.*, f.district_name as facility_district 
          FROM penalty_report p 
          LEFT JOIN ${cachedFacTable} f ON p.hospital_name = f.facility_name 
          WHERE ${pWhere} 
          ORDER BY p.complaint_raise_date DESC
        `);
        
        let aggStmt = env.DB.prepare(`
          SELECT 
            COALESCE(f.district_name, 'Unknown') as district,
            COUNT(p.id) as total_complaints,
            SUM(CASE WHEN LOWER(p.complaint_status) LIKE '%close%' OR LOWER(p.complaint_status) LIKE '%resolv%' THEN 1 ELSE 0 END) as resolved,
            SUM(CASE WHEN LOWER(p.complaint_status) NOT LIKE '%close%' AND LOWER(p.complaint_status) NOT LIKE '%resolv%' THEN 1 ELSE 0 END) as pending,
            SUM(COALESCE(CAST(p.attend_penalty AS REAL), 0)) as attend_penalty,
            SUM(COALESCE(CAST(p.penalty AS REAL), 0)) as close_penalty,
            SUM(COALESCE(CAST(p.total_penalty AS REAL), 0)) as total_penalty
          FROM penalty_report p
          LEFT JOIN ${cachedFacTable} f ON p.hospital_name = f.facility_name
          WHERE ${pWhere}
          GROUP BY district
          ORDER BY total_complaints DESC
        `);

        if (params.length > 0) {
          rawStmt = rawStmt.bind(...params);
          aggStmt = aggStmt.bind(...params);
        }

        const [penResult, districtSummary] = await Promise.all([rawStmt.all(), aggStmt.all()]);

        return new Response(safeStringify({ success: true, penalties: penResult.results || [], summary: districtSummary.results || [] }), { status: 200, headers });
      } catch (e: any) { 
        return new Response(safeStringify({ success: false, message: e.message }), { status: 500, headers }); 
      }
    }

    // ── EXPENSES API ──
    if (path.endsWith('/expenses') && method === 'GET') {
      let conds = ['1=1'];
      let params: any[] = [];
      
      if (!isAdmin) {
        if (isCoordinator || isDM) { conds.push(`u.zone_name = ?`); params.push(user.zone_name); }
        else if (isDI) { conds.push(`u.district_name = ?`); params.push(user.district_name); }
        else if (isManager) { conds.push(`(m.level_first_approver = ? OR m.level_second_approver = ?)`); params.push(userId, userId); }
        else { conds.push(`m.user_id = ?`); params.push(userId); }
      }
      if (filters.zone !== 'All') { conds.push(`u.zone_name = ?`); params.push(filters.zone); }
      if (filters.district !== 'All') {
        conds.push(`(u.district_name = ? OR EXISTS(SELECT 1 FROM expense_itinerary i2 WHERE i2.exp_id = m.exp_id AND i2.to_district = ?))`);
        params.push(filters.district, filters.district);
      }
      if (filters.engineer !== 'All') { conds.push(`m.user_id = ?`); params.push(filters.engineer); }
      if (filters.status !== 'All') {
        if (filters.status === 'Pending') conds.push(`m.status LIKE 'Pending%'`);
        else { conds.push(`m.status = ?`); params.push(filters.status); }
      }
      if (filters.startDate && filters.endDate) {
        conds.push(`(m.expense_date >= ? AND m.expense_date <= ?)`);
        params.push(filters.startDate, filters.endDate);
      }
      
      const eWhere = conds.join(' AND ');

      try {
        let rawStmt = env.DB.prepare(`
          SELECT m.exp_id, m.user_id, m.expense_date, m.total_amount, m.status,
                 m.level_first_approver, m.level_second_approver,
                 u.full_name, u.zone_name, u.district_name as user_district,
                 (SELECT SUM(distance_km) FROM expense_itinerary WHERE exp_id = m.exp_id) AS total_km
          FROM expense_master m
          JOIN user u ON m.user_id = u.user_id
          WHERE ${eWhere}
          ORDER BY m.expense_date DESC
        `);

        let aggStmt = env.DB.prepare(`
          SELECT 
            u.district_name as district,
            COUNT(m.exp_id) as total_complaints,
            SUM(CASE WHEN m.status = 'Approved' THEN 1 ELSE 0 END) as resolved,
            SUM(CASE WHEN m.status LIKE 'Pending%' THEN 1 ELSE 0 END) as pending
          FROM expense_master m
          JOIN user u ON m.user_id = u.user_id
          WHERE ${eWhere}
          GROUP BY u.district_name
          ORDER BY total_complaints DESC
        `);

        if (params.length > 0) {
          rawStmt = rawStmt.bind(...params);
          aggStmt = aggStmt.bind(...params);
        }

        const [expensesResult, districtSummary] = await Promise.all([rawStmt.all(), aggStmt.all()]);

        return new Response(safeStringify({ success: true, expenses: expensesResult.results || [], summary: districtSummary.results || [] }), { status: 200, headers });
      } catch (e: any) { 
        return new Response(safeStringify({ success: false, message: e.message }), { status: 500, headers }); 
      }
    }

    return new Response(safeStringify({ success: false, message: 'Route not found.' }), { status: 404, headers });

  } catch (dbError: any) {
    console.error("Critical Runtime Error:", dbError);
    return new Response(safeStringify({ success: false, message: 'Critical API Error.', error: dbError.message }), { status: 500, headers });
  }
};
