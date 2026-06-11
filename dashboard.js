/**
 * ============================================================
 * CYRIX HEALTHCARE — DASHBOARD API HANDLER (ADVANCED)
 * Features:
 * - Perfect Role-Based Mapping (Zone, District, Manager, Engineer)
 * - Custom Date Parsing for Penalty (DD-Mon-YYYY HH:MM:SS)
 * - Advanced Data Fetching
 * ============================================================
 */

function isMissing(v) { return v === null || v === undefined || ['', 'null', 'undefined'].includes(String(v).trim().toLowerCase()); }
function getCookieValue(header, key) { const m = header ? header.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)) : null; return m ? decodeURIComponent(m[1]) : null; }

function decodeJwtPayload(token) {
    try { const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4))); } 
    catch { return null; }
}

async function resolveUserId(request, url) {
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

/* Parse DD-Mon-YYYY HH:MM:SS to YYYY-MM-DD for SQLite */
function sqliteDateParser(col) {
    return `(SUBSTR(${col}, 8, 4) || '-' || CASE SUBSTR(${col}, 4, 3) WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04' WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08' WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12' END || '-' || SUBSTR(${col}, 1, 2))`;
}

export default async function dashboardHandler(request, env, corsHeaders) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const headers = { ...corsHeaders, 'Content-Type': 'application/json' };

    if (method === 'OPTIONS') return new Response(null, { headers });

    const userId = await resolveUserId(request, url);
    if (!userId) return new Response(JSON.stringify({ success: false, message: 'Unauthorized.' }), { status: 401, headers });

    try {
        const user = await env.DB.prepare('SELECT user_id, e_upkaran_id, full_name, role, zone_name, district_name FROM user WHERE user_id = ?').bind(userId).first();
        if (!user) return new Response(JSON.stringify({ success: false, message: 'User not found.' }), { status: 403, headers });

        const role = (user.role || '').trim();
        const isAdmin = role === 'Admin' || role === 'Superadmin';
        const isCoordinator = role === 'Coordinator' || role === 'Divisional Manager' || role === 'DM';
        const isDI = role === 'District Incharge' || role === 'DI';
        const isManager = role === 'Manager';
        const isEngineer = role === 'Engineer';
        const userName = user.full_name;

        /* ==================== FILTERS API ==================== */
        if (path.endsWith('/filters') && method === 'GET') {
            const usersRes = await env.DB.prepare(`SELECT user_id, full_name, role, zone_name, district_name, level_first_approver, e_upkaran_id FROM user WHERE account_status = 'Active'`).all();
            const hospRes = await env.DB.prepare(`SELECT DISTINCT hospital_name FROM penalty_report WHERE hospital_name IS NOT NULL`).all();
            return new Response(JSON.stringify({ success: true, users: usersRes.results || [], hospitals: hospRes.results || [] }), { status: 200, headers });
        }

        const days = parseInt(url.searchParams.get('days') || '30') || 0;
        const statusFilter = url.searchParams.get('status') || 'All';
        const zoneFilter = url.searchParams.get('zone') || 'All';
        const districtFilter = url.searchParams.get('district') || 'All';
        const managerFilter = url.searchParams.get('manager') || 'All';
        const engineerFilter = url.searchParams.get('engineer') || 'All';
        const hospitalFilter = url.searchParams.get('hospital') || 'All'; // New filter

        /* ==================== EXPENSES API ==================== */
        if (path.endsWith('/expenses') && method === 'GET') {
            let conditions = ['1=1'];
            let params = [];

            if (!isAdmin) {
                if (isCoordinator) { conditions.push('u.zone_name = ?'); params.push(user.zone_name); } 
                else if (isDI) { conditions.push('u.district_name = ?'); params.push(user.district_name); } 
                else if (isManager) { conditions.push('(m.level_first_approver = ? OR m.level_second_approver = ?)'); params.push(userId, userId); } 
                else { conditions.push('m.user_id = ?'); params.push(userId); }
            }

            if (zoneFilter !== 'All') { conditions.push('u.zone_name = ?'); params.push(zoneFilter); }
            if (districtFilter !== 'All') { conditions.push('u.district_name = ?'); params.push(districtFilter); }
            if (managerFilter !== 'All') { conditions.push('m.level_first_approver = ?'); params.push(managerFilter); }
            if (engineerFilter !== 'All') { conditions.push('m.user_id = ?'); params.push(engineerFilter); }
            if (statusFilter !== 'All') {
                if (statusFilter === 'Pending') conditions.push("m.status LIKE 'Pending%'");
                else { conditions.push('m.status = ?'); params.push(statusFilter); }
            }
            if (days > 0) { conditions.push(`m.expense_date >= date('now', '-${days} days')`); }

            const query = `
                SELECT m.exp_id, m.user_id, m.expense_date, m.total_amount, m.status, m.created_at, m.level_first_approver,
                       u.full_name, u.zone_name, u.district_name as user_district,
                       GROUP_CONCAT(DISTINCT i.travel_mode) AS travel_mode, SUM(i.distance_km) AS total_km, GROUP_CONCAT(DISTINCT i.to_district) AS district
                FROM expense_master m
                JOIN user u ON m.user_id = u.user_id
                LEFT JOIN expense_itinerary i ON i.exp_id = m.exp_id
                WHERE ${conditions.join(' AND ')}
                GROUP BY m.exp_id ORDER BY m.expense_date DESC LIMIT 1500
            `;

            let stmt = env.DB.prepare(query);
            if (params.length > 0) stmt = stmt.bind(...params);
            const expensesResult = await stmt.all();
            return new Response(JSON.stringify({ success: true, expenses: expensesResult.results || [] }), { status: 200, headers });
        }

        /* ==================== PENALTIES API ==================== */
        if (path.endsWith('/penalties') && method === 'GET') {
            let pCond = ['1=1'];
            let pParams = [];

            if (!isAdmin) {
                if (isCoordinator) {
                    pCond.push(`p.district_name IN (SELECT district_name FROM user WHERE zone_name = ?)`); pParams.push(user.zone_name);
                } else if (isDI) {
                    pCond.push('p.district_name = ?'); pParams.push(user.district_name);
                } else if (isManager) {
                    pCond.push(`(p.attend_engineer_id IN (SELECT e_upkaran_id FROM user WHERE level_first_approver = ?) OR p.close_engineer_id IN (SELECT e_upkaran_id FROM user WHERE level_first_approver = ?))`);
                    pParams.push(userId, userId);
                } else {
                    const eId = user.e_upkaran_id || 'XXX';
                    pCond.push('(p.attend_engineer_id = ? OR p.close_engineer_id = ?)'); pParams.push(eId, eId);
                }
            }

            if (zoneFilter !== 'All') { pCond.push(`p.district_name IN (SELECT district_name FROM user WHERE zone_name = ?)`); pParams.push(zoneFilter); }
            if (districtFilter !== 'All') { pCond.push('p.district_name = ?'); pParams.push(districtFilter); }
            if (hospitalFilter !== 'All') { pCond.push('p.hospital_name = ?'); pParams.push(hospitalFilter); }
            if (engineerFilter !== 'All') {
                pCond.push(`(p.attend_engineer_id IN (SELECT e_upkaran_id FROM user WHERE user_id = ?) OR p.close_engineer_id IN (SELECT e_upkaran_id FROM user WHERE user_id = ?))`);
                pParams.push(engineerFilter, engineerFilter);
            }

            if (days > 0) {
                const pDate = sqliteDateParser('p.complaint_raise_date');
                pCond.push(`(${pDate} >= date('now', '-${days} days'))`);
            }

            const penaltyQuery = `
                SELECT id, district_name, hospital_type, hospital_name, bar_code, equipment_name, complaint_id, 
                       complaint_raise_date, complaint_close_date, complaint_status, attend_date, attend_penalty, 
                       penalty, total_penalty, attend_engineer_id, close_engineer_id
                FROM penalty_report p
                WHERE ${pCond.join(' AND ')}
                ORDER BY ${sqliteDateParser('p.complaint_raise_date')} DESC LIMIT 1500
            `;

            let stmt = env.DB.prepare(penaltyQuery);
            if (pParams.length > 0) stmt = stmt.bind(...pParams);
            const penResult = await stmt.all();
            return new Response(JSON.stringify({ success: true, penalties: penResult.results || [] }), { status: 200, headers });
        }

        return new Response(JSON.stringify({ success: false, message: 'Route not found.' }), { status: 404, headers });
        
    } catch (dbError) {
        return new Response(JSON.stringify({ success: false, message: 'Database query failed.', error: dbError.message }), { status: 500, headers });
    }
}
