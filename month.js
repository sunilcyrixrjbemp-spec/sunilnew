// ============================================================
//  CYRIX HEALTHCARE — MONTH SUMMARY HANDLER (Production v2)
//  File   : month.js  (Cloudflare Workers + D1 / SQLite)
//  Tables : expense_master, expense_itinerary, expense_attachments, penalty_report
//
//  DB Schema (actual columns used):
//  expense_master:     exp_id, user_id, expense_date, da_amount,
//                      hotel_amount, local_purchase_desc, local_purchase_amount,
//                      other_expense_desc, other_expense_amount, visit_purpose,
//                      calls_assigned, calls_completed, pms_count, asset_tagging,
//                      total_amount, status, level_first_approver, level_second_approver
//
//  expense_itinerary:  itinerary_id, exp_id, leg_number, from_location, to_location,
//                      travel_mode, distance_km, travel_amount, working_district,
//                      da_amount, hotel_amount, other_desc, other_amount,
//                      calls_assigned, calls_completed, pms_count, asset_tagging,
//                      sub_mode, sub_km, sub_amount, to_district, from_district,
//                      visit_purpose
//
//  expense_attachments: id, exp_id, itinerary_id, bill_type, file_url
//
//  penalty_report:      hospital_name, attend_date, complaint_close_date, bar_code
//
//  Role access:
//  Admin, Superadmin, Travel Desk, Accounts → all data
//  Manager        → level_first_approver = user_id
//  Coordinator, Divisional Manager → level_second_approver = user_id
//  Engineer       → own data only
// ============================================================

const toFloat = (v) => parseFloat(v) || 0;

function jsonRes(data, status = 200, cors = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...cors },
    });
}

function bindAll(stmt, params) {
    return params.length ? stmt.bind(...params) : stmt;
}

// ── Date Filter ──────────────────────────────────────────────
function buildDateFilter(month, year, alias = "em") {
    const parts  = [];
    const params = [];

    if (month) {
        const mm = String(parseInt(month)).padStart(2, "0");
        parts.push(`strftime('%m', ${alias}.expense_date) = ?`);
        params.push(mm);
    }
    if (year) {
        parts.push(`strftime('%Y', ${alias}.expense_date) = ?`);
        params.push(String(parseInt(year)));
    }

    return {
        clause: parts.length ? "AND " + parts.join(" AND ") : "",
        params,
    };
}

// ── Role-Based Access Control ────────────────────────────────
async function buildAccessFilter(db, userId, role) {
    // Open access — see all engineers
    const openRoles = ["Admin", "Superadmin", "Travel Desk", "Accounts"];
    if (openRoles.includes(role)) {
        return { clause: "", params: [] };
    }

    // Manager sees engineers where they are level_first_approver
    if (role === "Manager") {
        return {
            clause: `AND em.level_first_approver = ?`,
            params: [userId],
        };
    }

    // Coordinator / Divisional Manager see engineers where they are level_second_approver
    if (role === "Coordinator" || role === "Divisional Manager") {
        return {
            clause: `AND em.level_second_approver = ?`,
            params: [userId],
        };
    }

    // Engineer — own data only
    if (role === "Engineer") {
        return {
            clause: `AND em.user_id = ?`,
            params: [userId],
        };
    }

    // Default: deny
    return { clause: "AND 1 = 0", params: [] };
}

// ════════════════════════════════════════════════════════════
//  SUMMARY  —  GET /api/month/summary
//  Params: user_id, status, month, year
// ════════════════════════════════════════════════════════════
async function handleSummary(url, env, cors) {
    const user_id = url.searchParams.get("user_id");
    const status  = url.searchParams.get("status") || "Approved";
    const month   = url.searchParams.get("month");
    const year    = url.searchParams.get("year");

    if (!user_id) {
        return jsonRes({ success: false, message: "user_id is required." }, 400, cors);
    }

    const db = env.DB;

    // 1. Get requester role
    let requester;
    try {
        requester = await db
            .prepare("SELECT role FROM user WHERE user_id = ? LIMIT 1")
            .bind(user_id)
            .first();
    } catch (e) {
        return jsonRes({ success: false, message: "DB error fetching user.", error: e.message }, 500, cors);
    }

    if (!requester) {
        return jsonRes({ success: false, message: "Unauthorized: user not found." }, 403, cors);
    }

    // 2. Build access + date filters
    const accessFilter = await buildAccessFilter(db, user_id, requester.role);
    const dateFilter   = buildDateFilter(month, year, "em");

    // 3. Aggregation SQL
    const sql = `
        SELECT
            u.user_id,
            u.full_name,
            u.e_code,
            u.designation,
            u.grade,
            u.district_name,
            u.mobile_number,
            COUNT(DISTINCT em.exp_id)                  AS expense_count,
            COALESCE(SUM(em.da_amount),                 0) AS da_amount,
            COALESCE(SUM(em.hotel_amount),              0) AS hotel_amount,
            COALESCE(SUM(em.local_purchase_amount),      0) AS local_purchase_amount,
            COALESCE(SUM(em.other_expense_amount),       0) AS other_expense_amount,
            COALESCE(SUM(ei.travel_amount),              0) AS travel_amount,
            COALESCE(SUM(ei.sub_amount),                 0) AS sub_amount,
            COALESCE(SUM(ei.distance_km),                0) AS total_km,
            COALESCE(SUM(em.total_amount),               0) AS total_amount
        FROM expense_master em
        INNER JOIN user u  ON u.user_id  = em.user_id
        LEFT  JOIN expense_itinerary ei ON ei.exp_id = em.exp_id
        WHERE em.status = ?
              ${dateFilter.clause}
              ${accessFilter.clause}
        GROUP BY
            u.user_id, u.full_name, u.e_code, u.designation, u.grade, u.district_name, u.mobile_number
        ORDER BY u.full_name ASC
    `;

    const bindParams = [status, ...dateFilter.params, ...accessFilter.params];

    let engineers = [];
    try {
        const res = await bindAll(db.prepare(sql), bindParams).all();
        engineers  = res.results || [];
    } catch (e) {
        console.error("[summary] SQL error:", e.message, "\nSQL:", sql);
        return jsonRes({ success: false, message: "Query failed.", error: e.message }, 500, cors);
    }

    return jsonRes({
        success:   true,
        count:     engineers.length,
        engineers: engineers.map((eng) => ({
            user_id:              String(eng.user_id),
            full_name:            eng.full_name            || "",
            e_code:               eng.e_code               || "",
            designation:          eng.designation          || "",
            grade:                eng.grade                || "",
            district_name:        eng.district_name        || "",
            mobile_number:        eng.mobile_number        || "",
            mobile:               eng.mobile_number        || "", // Kept for frontend fallback
            expense_count:        eng.expense_count        || 0,
            da_amount:            toFloat(eng.da_amount),
            hotel_amount:         toFloat(eng.hotel_amount),
            local_purchase_amount: toFloat(eng.local_purchase_amount),
            other_expense_amount: toFloat(eng.other_expense_amount),
            travel_amount:        toFloat(eng.travel_amount) + toFloat(eng.sub_amount),
            total_km:             toFloat(eng.total_km),
            total_amount:         toFloat(eng.total_amount),
        })),
    }, 200, cors);
}

// ════════════════════════════════════════════════════════════
//  DETAIL  —  GET /api/month/detail
//  Params: user_id, engineer_id, status, month, year
// ════════════════════════════════════════════════════════════
async function handleDetail(url, env, cors) {
    const user_id     = url.searchParams.get("user_id");
    const engineer_id = url.searchParams.get("engineer_id");
    const status      = url.searchParams.get("status") || "Approved";
    const month       = url.searchParams.get("month");
    const year        = url.searchParams.get("year");

    if (!user_id || !engineer_id) {
        return jsonRes({ success: false, message: "user_id and engineer_id are required." }, 400, cors);
    }

    const db = env.DB;

    // 1. Auth
    let requester;
    try {
        requester = await db
            .prepare("SELECT role FROM user WHERE user_id = ? LIMIT 1")
            .bind(user_id)
            .first();
    } catch (e) {
        return jsonRes({ success: false, message: "DB error.", error: e.message }, 500, cors);
    }

    if (!requester) {
        return jsonRes({ success: false, message: "Unauthorized: user not found." }, 403, cors);
    }

    // 2. Engineer: can only access own data
    if (requester.role === "Engineer" && String(user_id) !== String(engineer_id)) {
        return jsonRes({ success: false, message: "Access denied." }, 403, cors);
    }

    // 3. Manager: verify engineer is under their level_first_approver
    if (requester.role === "Manager") {
        try {
            const check = await db
                .prepare(`SELECT exp_id FROM expense_master WHERE user_id = ? AND level_first_approver = ? AND status = ? LIMIT 1`)
                .bind(engineer_id, user_id, status)
                .first();
            if (!check) return jsonRes({ success: false, message: "Access denied." }, 403, cors);
        } catch (e) {
            return jsonRes({ success: false, message: "Access check failed.", error: e.message }, 500, cors);
        }
    }

    // 4. Coordinator / Divisional Manager: verify via level_second_approver
    if (requester.role === "Coordinator" || requester.role === "Divisional Manager") {
        try {
            const check = await db
                .prepare(`SELECT exp_id FROM expense_master WHERE user_id = ? AND level_second_approver = ? AND status = ? LIMIT 1`)
                .bind(engineer_id, user_id, status)
                .first();
            if (!check) return jsonRes({ success: false, message: "Access denied." }, 403, cors);
        } catch (e) {
            return jsonRes({ success: false, message: "Access check failed.", error: e.message }, 500, cors);
        }
    }

    // 5. Date filter
    const dateFilter = buildDateFilter(month, year, "em");

    // 6. Fetch expenses from expense_master (Joined with User table)
    const expSql = `
        SELECT
            em.exp_id,
            em.user_id,
            u.full_name,
            u.e_code,
            u.grade,
            u.designation,
            u.district_name,
            u.mobile_number,
            em.expense_date,
            em.da_amount,
            em.hotel_amount,
            em.local_purchase_desc,
            em.local_purchase_amount,
            em.other_expense_desc,
            em.other_expense_amount,
            em.visit_purpose,
            em.calls_assigned,
            em.calls_completed,
            em.pms_count,
            em.asset_tagging,
            em.total_amount,
            em.status,
            em.level_first_approver,
            em.level_second_approver,
            (SELECT full_name FROM user WHERE user_id = em.level_first_approver) as l1_name,
            (SELECT full_name FROM user WHERE user_id = em.level_second_approver) as l2_name
        FROM expense_master em
        LEFT JOIN user u ON u.user_id = em.user_id
        WHERE em.user_id = ?
          AND em.status  = ?
              ${dateFilter.clause}
        ORDER BY em.expense_date ASC
    `;

    const expParams = [engineer_id, status, ...dateFilter.params];
    let expenses = [];
    try {
        const res = await bindAll(db.prepare(expSql), expParams).all();
        expenses  = res.results || [];
    } catch (e) {
        console.error("[detail] expense SQL error:", e.message);
        return jsonRes({ success: false, message: "Query failed.", error: e.message }, 500, cors);
    }

    if (expenses.length === 0) {
        return jsonRes({ success: true, expenses: [] }, 200, cors);
    }

    // 7. Fetch itineraries and check barcode from penalty_report (DATE MATCH ISSUE FIXED HERE)
    const expIds = expenses.map((e) => e.exp_id);
    const itiPH  = expIds.map(() => "?").join(",");

    let itineraries = [];
    try {
        // Correctly fetch right 8 characters of barcode.
        const res = await db
            .prepare(
                `SELECT
                    ei.itinerary_id,
                    ei.exp_id,
                    ei.leg_number,
                    ei.from_location,
                    ei.to_location,
                    ei.from_district,
                    ei.to_district,
                    ei.travel_mode,
                    ei.sub_mode,
                    ei.sub_km,
                    ei.distance_km,
                    ei.travel_amount,
                    ei.sub_amount,
                    ei.visit_purpose,
                    ei.working_district,
                    ei.da_amount,
                    ei.hotel_amount,
                    ei.other_desc,
                    ei.other_amount,
                    ei.calls_assigned,
                    ei.calls_completed,
                    ei.pms_count,
                    ei.asset_tagging,
                    (
                        SELECT GROUP_CONCAT(DISTINCT SUBSTR(pr.bar_code, -8))
                        FROM penalty_report pr
                        WHERE (
                                (ei.from_location IS NOT NULL AND ei.from_location != '' AND pr.hospital_name = ei.from_location)
                                OR 
                                (ei.to_location IS NOT NULL AND ei.to_location != '' AND pr.hospital_name = ei.to_location)
                              )
                          AND (
                              pr.attend_date LIKE SUBSTR(em.expense_date, 1, 10) || '%' OR
                              pr.complaint_close_date LIKE SUBSTR(em.expense_date, 1, 10) || '%' OR
                              SUBSTR(em.expense_date, 1, 10) LIKE '%' || SUBSTR(pr.attend_date, 1, 10) || '%'
                          )
                    ) as auto_asset_tagging
                 FROM expense_itinerary ei
                 JOIN expense_master em ON ei.exp_id = em.exp_id
                 WHERE ei.exp_id IN (${itiPH})
                 ORDER BY ei.exp_id ASC, ei.leg_number ASC`
            )
            .bind(...expIds)
            .all();
        itineraries = res.results || [];
    } catch (e) {
        console.error("[detail] itinerary SQL error:", e.message);
        itineraries = [];
    }

    // 8. Fetch attachments
    let attachments = [];
    try {
        const res = await db
            .prepare(
                `SELECT
                    ea.id,
                    ea.exp_id,
                    ea.itinerary_id,
                    ea.file_url,
                    ea.bill_type
                 FROM expense_attachments ea
                 WHERE ea.exp_id IN (${itiPH})`
            )
            .bind(...expIds)
            .all();
        attachments = res.results || [];
    } catch (e) {
        console.error("[detail] attachments SQL error:", e.message);
        attachments = [];
    }

    // 9. Group itineraries and attachments by exp_id
    const itiMap    = {};
    const expAttMap = {};

    itineraries.forEach((leg) => {
        if (!itiMap[leg.exp_id]) itiMap[leg.exp_id] = [];
        const legAtts = attachments.filter((a) => String(a.itinerary_id) === String(leg.itinerary_id));
        itiMap[leg.exp_id].push({ ...leg, attachments: legAtts });
    });

    attachments.forEach((att) => {
        if (!att.itinerary_id) {
            if (!expAttMap[att.exp_id]) expAttMap[att.exp_id] = [];
            expAttMap[att.exp_id].push(att);
        }
    });

    // 10. Build result — every field needed by PDF generator
    const result = expenses.map((exp) => ({
        expense_id:            exp.exp_id,
        user_id:               exp.user_id,
        full_name:             exp.full_name || "",
        e_code:                exp.e_code || "",
        grade:                 exp.grade || "",
        designation:           exp.designation || "",
        district_name:         exp.district_name || "",
        mobile_number:         exp.mobile_number || "",
        mobile:                exp.mobile_number || "", 
        l1_name:               exp.l1_name || "",
        l2_name:               exp.l2_name || "",
        expense_date:          exp.expense_date,
        da_amount:             toFloat(exp.da_amount),
        hotel_amount:          toFloat(exp.hotel_amount),
        local_purchase_desc:   exp.local_purchase_desc        || "",
        local_purchase_amount: toFloat(exp.local_purchase_amount),
        other_expense_desc:    exp.other_expense_desc         || "",
        other_expense_amount:  toFloat(exp.other_expense_amount),
        visit_purpose:         exp.visit_purpose              || "",
        calls_assigned:        exp.calls_assigned             || 0,
        calls_completed:       exp.calls_completed            || 0,
        pms_count:             exp.pms_count                  || 0,
        asset_tagging:         exp.asset_tagging              || "",
        total_amount:          toFloat(exp.total_amount),
        status:                exp.status,
        level_first_approver:  exp.level_first_approver,
        level_second_approver: exp.level_second_approver,

        itineraries: (itiMap[exp.exp_id] || []).map((leg) => ({
            itinerary_id:     leg.itinerary_id,
            leg_number:       leg.leg_number       || 0,
            from_location:    leg.from_location    || "",
            to_location:      leg.to_location      || "",
            from_district:    leg.from_district    || "",
            to_district:      leg.to_district      || "",
            travel_mode:      leg.travel_mode      || "",
            sub_mode:         leg.sub_mode         || "",
            sub_km:           toFloat(leg.sub_km),
            distance_km:      toFloat(leg.distance_km),
            travel_amount:    toFloat(leg.travel_amount),
            sub_amount:       toFloat(leg.sub_amount),
            visit_purpose:    leg.visit_purpose    || "",
            working_district: leg.working_district || "",
            da_amount:        toFloat(leg.da_amount),
            hotel_amount:     toFloat(leg.hotel_amount),
            other_desc:       leg.other_desc       || "",
            other_amount:     toFloat(leg.other_amount),
            calls_assigned:   leg.calls_assigned   || 0,
            calls_completed:  leg.calls_completed  || 0,
            pms_count:        leg.pms_count        || 0,
            // If barcode is found from penalty_report, use it. Otherwise fallback to the typed asset_tagging.
            asset_tagging:    leg.auto_asset_tagging ? leg.auto_asset_tagging : (leg.asset_tagging || ""),
            attachments: (leg.attachments || []).map((a) => ({
                attachment_id: a.id,
                url:           a.file_url  || "",
                bill_type:     a.bill_type || "",
            })),
        })),

        // Attachments at expense level (not linked to specific itinerary)
        expense_attachments: (expAttMap[exp.exp_id] || []).map((a) => ({
            attachment_id: a.id,
            url:           a.file_url  || "",
            bill_type:     a.bill_type || "",
        })),
    }));

    return jsonRes({ success: true, expenses: result }, 200, cors);
}

// ════════════════════════════════════════════════════════════
//  MAIN EXPORT
// ════════════════════════════════════════════════════════════
export default async function monthHandler(request, env, corsHeaders) {
    const url  = new URL(request.url);
    const path = url.pathname;

    try {
        if (path === "/api/month/summary") return await handleSummary(url, env, corsHeaders);
        if (path === "/api/month/detail")  return await handleDetail(url, env, corsHeaders);
        return jsonRes({ success: false, message: "Route not found." }, 404, corsHeaders);
    } catch (err) {
        console.error("[month.js] Unhandled error:", err);
        return jsonRes({ success: false, message: "Internal server error.", error: err.message }, 500, corsHeaders);
    }
}
