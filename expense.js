/**
 * ============================================================
 * CYRIX HEALTHCARE — EXPENSE CENTER BACKEND
 * File: expense.js
 * Worker: Cloudflare Workers + D1 (SQLite) + R2 (BILLS_BUCKET / cyrixapp)
 * ============================================================
 */

/* ── Helpers (Sahayak Functions) ─────────────────────────── */

function isMissing(value) {
    if (value === null || value === undefined) return true;
    const normalized = String(value).trim().toLowerCase();
    return normalized === "" || normalized === "null" || normalized === "undefined";
}

function getCookieValue(cookieHeader, key) {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
    return match ? decodeURIComponent(match[1]) : null;
}

function decodeJwtPayload(token) {
    try {
        const parts = token.split(".");
        if (parts.length < 2) return null;
        const base64Url = parts[1];
        const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
        return JSON.parse(atob(padded));
    } catch {
        return null;
    }
}

async function resolveLoggedInUserId(request, url, body = null, formData = null) {
    const candidates = [
        url.searchParams.get("user_id"),
        url.searchParams.get("userId"),
        request.headers.get("x-user-id"),
        request.headers.get("x-userid"),
        request.headers.get("x-user"),
        request.headers.get("cf-user-id")
    ];

    if (body) {
        candidates.push(body.user_id);
        candidates.push(body.userId);
    }

    if (formData) {
        candidates.push(formData.get("user_id"));
        candidates.push(formData.get("userId"));
    }

    const cookieHeader = request.headers.get("cookie") || "";
    candidates.push(getCookieValue(cookieHeader, "user_id"));
    candidates.push(getCookieValue(cookieHeader, "userId"));

    const authHeader = request.headers.get("Authorization") || request.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const payload = decodeJwtPayload(authHeader.slice(7).trim());
        if (payload) {
            candidates.push(payload.user_id, payload.userId, payload.uid, payload.sub);
        }
    }

    const userId = candidates.find((v) => !isMissing(v));
    return isMissing(userId) ? null : String(userId).trim();
}

/* ── Main Handler ─────────────────────────────────────────── */

export default async function expenseHandler(request, env, corsHeaders) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {

        /* ================================================================
           GET /api/expense/init
           Returns user info, allowance, facilities, submitted dates
        ================================================================ */
        if (path === "/api/expense/init" && method === "GET") {
            const userId = await resolveLoggedInUserId(request, url);
            if (!userId) {
                return new Response(JSON.stringify({ success: false, message: "Unauthorized: Please login first." }), { status: 401, headers });
            }

            // Get month from parameter, or default to current
            const reqMonth = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);

            const [user, kmRes, autoRes, facResList, submittedRes, approvedKmReq, approvedAutoReq, existingKmMonth, existingAutoMonth] = await Promise.all([
                env.DB.prepare("SELECT full_name, e_code, grade, district_name as home_district, level_first_approver, level_second_approver FROM user WHERE user_id = ?").bind(userId).first(),
                env.DB.prepare(`SELECT SUM(distance_km) as total_km FROM expense_itinerary i JOIN expense_master m ON i.exp_id = m.exp_id WHERE m.user_id = ? AND strftime('%Y-%m', m.expense_date) = ? AND (i.travel_mode = 'Bike' OR i.travel_mode = 'Car')`).bind(userId, reqMonth).first().catch(() => ({ total_km: 0 })),
                env.DB.prepare(`SELECT COALESCE(SUM(i.travel_amount), 0) + COALESCE(SUM(i.sub_amount), 0) as total_auto FROM expense_itinerary i JOIN expense_master m ON i.exp_id = m.exp_id WHERE m.user_id = ? AND strftime('%Y-%m', m.expense_date) = ? AND (i.travel_mode = 'Auto' OR i.sub_mode = 'Auto')`).bind(userId, reqMonth).first().catch(() => ({ total_auto: 0 })),
                env.DB.prepare('SELECT district_name, facility_name FROM "Facily Details"').all().catch(() => ({ results: [] })),
                env.DB.prepare("SELECT expense_date FROM expense_master WHERE user_id = ? AND strftime('%Y-%m', expense_date) = ?").bind(userId, reqMonth).all().catch(() => ({ results: [] })),
                
                // Fetch approved limit value specifically for this requested month using 'for_month'
                env.DB.prepare(`SELECT COALESCE(SUM(requested_value), 0) as approved_km FROM limit_approval_requests WHERE user_id = ? AND request_type = 'KM' AND LOWER(status) = 'approved' AND for_month = ?`).bind(userId, reqMonth).first().catch(() => ({ approved_km: 0 })),
                env.DB.prepare(`SELECT COALESCE(SUM(requested_value), 0) as approved_auto FROM limit_approval_requests WHERE user_id = ? AND request_type = 'AUTO' AND LOWER(status) = 'approved' AND for_month = ?`).bind(userId, reqMonth).first().catch(() => ({ approved_auto: 0 })),
                
                // Check if an existing request (any status) exists for this month
                env.DB.prepare(`SELECT status, requested_value FROM limit_approval_requests WHERE user_id = ? AND request_type = 'KM' AND for_month = ? ORDER BY id DESC LIMIT 1`).bind(userId, reqMonth).first().catch(() => null),
                env.DB.prepare(`SELECT status, requested_value FROM limit_approval_requests WHERE user_id = ? AND request_type = 'AUTO' AND for_month = ? ORDER BY id DESC LIMIT 1`).bind(userId, reqMonth).first().catch(() => null)
            ]);

            if (!user) {
                return new Response(JSON.stringify({ success: false, message: "Invalid User: You don't have access to submit expenses." }), { status: 403, headers });
            }

            let allowance = await env.DB.prepare("SELECT * FROM allowance_master WHERE grade = ?").bind(user.grade).first().catch(() => null);
            if (!allowance) {
                allowance = {
                    daily_in_district: 250,
                    daily_out_district: 400,
                    daily_hotel: 350,
                    daily_out_state: 600,
                    hotel_in_state_s: 1500,
                    max_km_per_month: 2000,
                    rate_bike: 4.5,
                    rate_car: 9.0,
                    vehicle_type: "Bike"
                };
            } else {
                allowance.daily_in_district = allowance.daily_in_district || 250;
                allowance.daily_out_district = allowance.daily_out_district || 400;
                allowance.daily_hotel = allowance.daily_hotel || 350;
                allowance.daily_out_state = allowance.daily_out_state || 600;
            }

            allowance.current_month_km = kmRes ? (kmRes.total_km || 0) : 0;
            allowance.current_month_auto = autoRes ? (autoRes.total_auto || 0) : 0;
            allowance.max_auto_per_month = 1000;

            const facilities = {};
            if (facResList && facResList.results) {
                facResList.results.forEach((f) => {
                    if (!facilities[f.district_name]) facilities[f.district_name] = [];
                    facilities[f.district_name].push(f.facility_name);
                });
            }

            const submitted_dates = submittedRes && submittedRes.results
                ? submittedRes.results.map((r) => r.expense_date)
                : [];

            const dateObj = new Date();
            const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
            const yy = String(dateObj.getFullYear()).slice(-2);

            return new Response(JSON.stringify({
                success: true,
                user,
                allowance,
                facilities,
                submitted_dates,
                approved_km: approvedKmReq ? approvedKmReq.approved_km : 0,
                approved_auto: approvedAutoReq ? approvedAutoReq.approved_auto : 0,
                existing_km_req: existingKmMonth || null,
                existing_auto_req: existingAutoMonth || null,
                next_exp_id: `RJ-${mm}/${yy}-PENDING`
            }), { status: 200, headers });
        }


        /* ================================================================
           GET /api/expense/edit
           Load existing expense for editing (only Pending status allowed)
        ================================================================ */
        if (path === "/api/expense/edit" && method === "GET") {
            const userId = await resolveLoggedInUserId(request, url);
            const expId = url.searchParams.get("exp_id");

            if (!userId) {
                return new Response(JSON.stringify({ success: false, message: "Unauthorized." }), { status: 401, headers });
            }
            if (!expId) {
                return new Response(JSON.stringify({ success: false, message: "exp_id is required." }), { status: 400, headers });
            }

            const expense = await env.DB.prepare(`
                SELECT m.*, u.full_name, u.e_code, u.grade, u.district_name as home_district
                FROM expense_master m
                JOIN user u ON m.user_id = u.user_id
                WHERE m.exp_id = ?
            `).bind(expId).first();

            if (!expense) {
                return new Response(JSON.stringify({ success: false, message: "Expense not found." }), { status: 404, headers });
            }

            if (expense.user_id !== userId) {
                return new Response(JSON.stringify({ success: false, message: "Access Denied: You can only edit your own expenses." }), { status: 403, headers });
            }

            if (!expense.status.toLowerCase().includes("pending")) {
                return new Response(JSON.stringify({
                    success: false,
                    message: `This expense is already ${expense.status} and cannot be edited.`
                }), { status: 409, headers });
            }

            const { results: itineraries } = await env.DB.prepare(`
                SELECT i.*,
                    COALESCE(
                        (SELECT GROUP_CONCAT(a.file_url || '::' || a.bill_type, '|||')
                         FROM expense_attachments a
                         WHERE a.itinerary_id = i.itinerary_id),
                        ''
                    ) as attachments_raw
                FROM expense_itinerary i
                WHERE i.exp_id = ?
                ORDER BY i.leg_number ASC
            `).bind(expId).all();

            const enrichedItineraries = (itineraries || []).map(leg => {
                const attachments = [];
                if (leg.attachments_raw) {
                    leg.attachments_raw.split("|||").filter(Boolean).forEach(raw => {
                        const [url_val, bill_type] = raw.split("::");
                        if (url_val) attachments.push({ url: url_val, bill_type: bill_type || "" });
                    });
                }
                return {
                    ...leg,
                    leg: leg.leg_number,
                    from: leg.from_location,
                    to: leg.to_location,
                    mode: leg.travel_mode,
                    km: leg.distance_km,
                    amount: leg.travel_amount,
                    district: leg.to_district,
                    district_from: leg.from_district,
                    travel_type: leg.from_district !== leg.to_district ? "Outdoor" : "In-District",
                    ws_assigned: leg.calls_assigned,
                    ws_closed: leg.calls_completed,
                    ws_pms: leg.pms_count,
                    ws_asset: leg.asset_tagging,
                    da: leg.da_amount,
                    hotel: leg.hotel_amount,
                    oth_desc: leg.other_desc,
                    oth_amount: leg.other_amount,
                    attachments,
                    attachments_raw: undefined
                };
            });

            return new Response(JSON.stringify({
                success: true,
                expense,
                itineraries: enrichedItineraries
            }), { status: 200, headers });
        }


        /* ================================================================
           PUT /api/expense/edit
           Update an existing pending expense (multipart/form-data)
        ================================================================ */
        if (path === "/api/expense/edit" && method === "PUT") {
            const formData = await request.formData();
            const userId = await resolveLoggedInUserId(request, url, null, formData);
            const expId = formData.get("exp_id");

            if (!userId) {
                return new Response(JSON.stringify({ success: false, message: "Unauthorized." }), { status: 401, headers });
            }
            if (!expId) {
                return new Response(JSON.stringify({ success: false, message: "exp_id is required." }), { status: 400, headers });
            }

            const existing = await env.DB.prepare(
                "SELECT user_id, status, expense_date FROM expense_master WHERE exp_id = ?"
            ).bind(expId).first();

            if (!existing) {
                return new Response(JSON.stringify({ success: false, message: "Expense not found." }), { status: 404, headers });
            }
            if (existing.user_id !== userId) {
                return new Response(JSON.stringify({ success: false, message: "Access Denied: You can only edit your own expenses." }), { status: 403, headers });
            }
            if (!existing.status.toLowerCase().includes("pending")) {
                return new Response(JSON.stringify({
                    success: false,
                    message: `Cannot edit: Expense is already ${existing.status}.`
                }), { status: 409, headers });
            }

            const expDate = formData.get("exp_date") || formData.get("expense_date") || existing.expense_date;
            const currentMonthStr = expDate.slice(0, 7); // 'YYYY-MM'

            const itiStr = formData.get("itineraries");
            let itineraries = [];
            let total_da = 0, total_hotel = 0, total_other = 0;
            let total_assigned = 0, total_completed = 0, total_pms = 0, total_asset = 0;

            if (itiStr) {
                try {
                    itineraries = JSON.parse(itiStr);
                } catch {
                    return new Response(JSON.stringify({ success: false, message: "Invalid itineraries payload." }), { status: 400, headers });
                }

                for (const iti of itineraries) {
                    total_da += parseFloat(iti.da || 0);
                    total_hotel += parseFloat(iti.hotel || 0);
                    total_other += parseFloat(iti.oth_amount || 0);
                    total_assigned += parseInt(iti.ws_assigned || 0, 10);
                    total_completed += parseInt(iti.ws_closed || 0, 10);
                    total_pms += parseInt(iti.ws_pms || 0, 10);
                    total_asset += parseInt(iti.ws_asset || 0, 10);
                }
            }

            /* ── STRICT LIMIT VALIDATION CHECK ── */
            let incoming_km = 0;
            let incoming_auto = 0;
            for (const iti of itineraries) {
                if (iti.mode === 'Bike' || iti.mode === 'Car') {
                    incoming_km += parseFloat(iti.km || 0);
                }
                if (iti.mode === 'Auto') {
                    incoming_auto += parseFloat(iti.amount || 0);
                }
                if (iti.sub_mode === 'Auto') {
                    incoming_auto += parseFloat(iti.sub_amount || 0);
                }
            }

            // Exclude old values of this specific modified expense first
            const oldKmRow = await env.DB.prepare(`
                SELECT COALESCE(SUM(distance_km), 0) as total_km 
                FROM expense_itinerary 
                WHERE exp_id = ? AND (travel_mode = 'Bike' OR travel_mode = 'Car')
            `).bind(expId).first().catch(() => ({ total_km: 0 }));

            const oldAutoRow = await env.DB.prepare(`
                SELECT COALESCE(SUM(travel_amount), 0) + COALESCE(SUM(sub_amount), 0) as total_auto 
                FROM expense_itinerary 
                WHERE exp_id = ? AND (travel_mode = 'Auto' OR sub_mode = 'Auto')
            `).bind(expId).first().catch(() => ({ total_auto: 0 }));

            const old_km = oldKmRow ? (oldKmRow.total_km || 0) : 0;
            const old_auto = oldAutoRow ? (oldAutoRow.total_auto || 0) : 0;

            const [accumulatedKmRow, accumulatedAutoRow, allowanceRow, approvedKmRequests, approvedAutoRequests] = await Promise.all([
                env.DB.prepare(`
                    SELECT COALESCE(SUM(i.distance_km), 0) as total_km 
                    FROM expense_itinerary i 
                    JOIN expense_master m ON i.exp_id = m.exp_id 
                    WHERE m.user_id = ? 
                      AND strftime('%Y-%m', m.expense_date) = ? 
                      AND (i.travel_mode = 'Bike' OR i.travel_mode = 'Car')
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_km: 0 })),
                
                env.DB.prepare(`
                    SELECT COALESCE(SUM(i.travel_amount), 0) + COALESCE(SUM(i.sub_amount), 0) as total_auto 
                    FROM expense_itinerary i 
                    JOIN expense_master m ON i.exp_id = m.exp_id 
                    WHERE m.user_id = ? 
                      AND strftime('%Y-%m', m.expense_date) = ? 
                      AND (i.travel_mode = 'Auto' OR i.sub_mode = 'Auto')
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_auto: 0 })),
                
                env.DB.prepare("SELECT max_km_per_month FROM allowance_master WHERE grade = (SELECT grade FROM user WHERE user_id = ?)").bind(userId).first().catch(() => null),
                
                env.DB.prepare(`
                    SELECT COALESCE(SUM(requested_value), 0) as total_approved_km 
                    FROM limit_approval_requests 
                    WHERE user_id = ? AND request_type = 'KM' AND LOWER(status) = 'approved' 
                      AND for_month = ?
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_approved_km: 0 })),
                
                env.DB.prepare(`
                    SELECT COALESCE(SUM(requested_value), 0) as total_approved_auto 
                    FROM limit_approval_requests 
                    WHERE user_id = ? AND request_type = 'AUTO' AND LOWER(status) = 'approved' 
                      AND for_month = ?
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_approved_auto: 0 }))
            ]);

            const max_km_per_month = allowanceRow ? (allowanceRow.max_km_per_month || 2000) : 2000;
            const max_auto_per_month = 1000;

            const current_accumulated_km = Math.max(0, (accumulatedKmRow ? (accumulatedKmRow.total_km || 0) : 0) - old_km);
            const projected_total_km = current_accumulated_km + incoming_km;

            if (projected_total_km > max_km_per_month) {
                const excess_km = projected_total_km - max_km_per_month;
                const approved_km_limit = approvedKmRequests ? (approvedKmRequests.total_approved_km || 0) : 0;
                
                if (approved_km_limit < excess_km) {
                    const missing_km = excess_km - approved_km_limit;
                    return new Response(JSON.stringify({ 
                        success: false, 
                        message: `Submission Locked: You have exceeded your monthly KM limit by ${missing_km.toFixed(2)} km. You must request approval from your Level 1 Manager to proceed.` 
                    }), { status: 400, headers });
                }
            }

            const current_accumulated_auto = Math.max(0, (accumulatedAutoRow ? (accumulatedAutoRow.total_auto || 0) : 0) - old_auto);
            const projected_total_auto = current_accumulated_auto + incoming_auto;

            if (projected_total_auto > max_auto_per_month) {
                const excess_auto = projected_total_auto - max_auto_per_month;
                const approved_auto_limit = approvedAutoRequests ? (approvedAutoRequests.total_approved_auto || 0) : 0;
                
                if (approved_auto_limit < excess_auto) {
                    const missing_auto = excess_auto - approved_auto_limit;
                    return new Response(JSON.stringify({ 
                        success: false, 
                        message: `Submission Locked: You have exceeded your monthly Auto limit by ₹${missing_auto.toFixed(2)}. You must request approval from your Level 1 Manager to proceed.` 
                    }), { status: 400, headers });
                }
            }

            /* ── UPDATE TRANSACTION EXECUTION ── */
            await env.DB.prepare(`
                UPDATE expense_master
                SET total_amount = ?,
                    da_amount = ?,
                    hotel_amount = ?,
                    other_expense_amount = ?,
                    calls_assigned = ?,
                    calls_completed = ?,
                    pms_count = ?,
                    asset_tagging = ?
                WHERE exp_id = ?
            `).bind(
                formData.get("total_amount"),
                total_da, total_hotel, total_other,
                total_assigned, total_completed, total_pms, total_asset,
                expId
            ).run();

            const r2Domain = env.R2_PUBLIC_DOMAIN || "https://pub-cyrixapp.r2.dev";

            const uploadFile = async (fileKey, type, itiId) => {
                const file = formData.get(fileKey);
                if (file && file.size > 0 && env.BILLS_BUCKET) {
                    const safeName = String(file.name || "file").replace(/\s+/g, "_");
                    const fileName = `bills/${expId}_${type}_${Date.now()}_${safeName}`;
                    await env.BILLS_BUCKET.put(fileName, file.stream());
                    const fileUrl = `${r2Domain}/${fileName}`;
                    await env.DB.prepare(
                        "INSERT INTO expense_attachments (exp_id, itinerary_id, bill_type, file_url) VALUES (?, ?, ?, ?)"
                    ).bind(expId, itiId, type, fileUrl).run();
                    return fileUrl;
                }
                return null;
            };

            for (const iti of itineraries) {
                const itiId = `${expId}-${iti.leg}`;
                const fromDistrict = iti.travel_type === "Outdoor"
                    ? (iti.district_from || iti.district)
                    : iti.district;

                const existingLeg = await env.DB.prepare(
                    "SELECT itinerary_id FROM expense_itinerary WHERE itinerary_id = ?"
                ).bind(itiId).first();

                if (existingLeg) {
                    await env.DB.prepare(`
                        UPDATE expense_itinerary
                        SET from_district = ?, to_district = ?,
                            from_location = ?, to_location = ?,
                            travel_mode = ?, distance_km = ?, travel_amount = ?,
                            sub_mode = ?, sub_amount = ?,
                            da_amount = ?, hotel_amount = ?,
                            other_desc = ?, other_amount = ?,
                            calls_assigned = ?, calls_completed = ?,
                            pms_count = ?, asset_tagging = ?,
                            visit_purpose = ?
                        WHERE itinerary_id = ?
                    `).bind(
                        fromDistrict, iti.district,
                        iti.from, iti.to,
                        iti.mode, iti.km, iti.amount,
                        iti.sub_mode || null, iti.sub_amount || null,
                        iti.da, iti.hotel,
                        iti.oth_desc || null, iti.oth_amount || null,
                        iti.ws_assigned, iti.ws_closed, iti.ws_pms, iti.ws_asset,
                        iti.visit_purpose || null,
                        itiId
                    ).run();
                } else {
                    await env.DB.prepare(`
                        INSERT INTO expense_itinerary (
                            itinerary_id, exp_id, leg_number,
                            from_district, to_district,
                            from_location, to_location,
                            travel_mode, distance_km, travel_amount,
                            sub_mode, sub_amount,
                            da_amount, hotel_amount,
                            other_desc, other_amount,
                            calls_assigned, calls_completed, pms_count, asset_tagging,
                            visit_purpose
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                        itiId, expId, iti.leg,
                        fromDistrict, iti.district,
                        iti.from, iti.to,
                        iti.mode, iti.km, iti.amount,
                        iti.sub_mode || null, iti.sub_amount || null,
                        iti.da, iti.hotel,
                        iti.oth_desc || null, iti.oth_amount || null,
                        iti.ws_assigned, iti.ws_closed, iti.ws_pms, iti.ws_asset,
                        iti.visit_purpose || null
                    ).run();
                }

                if (iti.travel_type === "Outdoor") await uploadFile(`comm_mail_${iti.leg}`, "Communication_Mail", itiId);
                await uploadFile(`main_bill_${iti.leg}`, iti.mode, itiId);
                if (iti.sub_mode) await uploadFile(`sub_bill_${iti.leg}`, iti.sub_mode, itiId);
                if (iti.leg === 1) await uploadFile("hotel_bill_1", "Hotel", itiId);
                await uploadFile(`oth_bill_${iti.leg}`, "Other_Expense", itiId);
            }

            return new Response(JSON.stringify({
                success: true,
                message: "Expense updated successfully.",
                exp_id: expId
            }), { status: 200, headers });
        }


        /* ================================================================
           POST /api/expense/limit-request
           STRICT APPROVER LOGIC: Assigns request strictly to level_first_approver
        ================================================================ */
        if (path === "/api/expense/limit-request" && method === "POST") {
            let userId = null;
            let type = null;
            let amount = null;
            let reqMonth = null;

            // Handle both JSON and multipart/FormData payloads gracefully
            const contentType = request.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
                const body = await request.json().catch(() => ({}));
                userId = body.user_id || body.userId;
                type = body.type;
                amount = body.amount;
                reqMonth = body.month;
            } else {
                const formData = await request.formData().catch(() => null);
                if (formData) {
                    userId = formData.get("user_id") || formData.get("userId");
                    type = formData.get("type");
                    amount = formData.get("amount");
                    reqMonth = formData.get("month");
                }
            }

            if (!reqMonth) {
                reqMonth = new Date().toISOString().slice(0, 7);
            }

            // Resolve userId fallback if missing in body payload
            if (!userId) {
                userId = await resolveLoggedInUserId(request, url);
            }

            if (!userId) {
                return new Response(JSON.stringify({ success: false, message: "Unauthorized: Please login first." }), { status: 401, headers });
            }

            if (isMissing(type) || isMissing(amount)) {
                return new Response(JSON.stringify({ success: false, message: "Type ('KM'/'AUTO') and amount are required." }), { status: 400, headers });
            }

            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                return new Response(JSON.stringify({ success: false, message: "Please enter a valid requested amount greater than 0." }), { status: 400, headers });
            }

            // Safety Check: Create limit_approval_requests table in D1 if it doesn't exist
            try {
                await env.DB.prepare(`
                    CREATE TABLE IF NOT EXISTS limit_approval_requests (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id TEXT NOT NULL,
                        manager_id TEXT NOT NULL,
                        request_type TEXT NOT NULL,
                        requested_value REAL NOT NULL,
                        status TEXT NOT NULL DEFAULT 'Pending',
                        for_month TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `).run();
                
                // Add column if missing in older schema
                await env.DB.prepare("ALTER TABLE limit_approval_requests ADD COLUMN for_month TEXT").run().catch(() => {});
                // Fix old rows without month
                await env.DB.prepare("UPDATE limit_approval_requests SET for_month = strftime('%Y-%m', created_at) WHERE for_month IS NULL").run().catch(() => {});
            } catch (err) {
                console.error("Auto-create limit_approval_requests table failed:", err.message);
            }

            // [STRICT APPROVER MAPPING] Fetch exact Level 1 Approver for this user
            const user = await env.DB.prepare(
                "SELECT level_first_approver FROM user WHERE user_id = ?"
            ).bind(userId).first();

            if (!user) {
                return new Response(JSON.stringify({ success: false, message: `User account (${userId}) not found in the database.` }), { status: 404, headers });
            }

            const managerId = user.level_first_approver;
            if (isMissing(managerId)) {
                return new Response(JSON.stringify({ 
                    success: false, 
                    message: "Approval Blocked: No Level 1 Manager is mapped to your profile. You cannot request a limit extension without an assigned manager." 
                }), { status: 400, headers });
            }
            
            // ONE REQUEST PER MONTH LOGIC: Check if request already exists for this category this month
            const existingReq = await env.DB.prepare(`
                SELECT id, status FROM limit_approval_requests 
                WHERE user_id = ? AND request_type = ? AND for_month = ?
            `).bind(userId, type, reqMonth).first().catch(() => null);

            if (existingReq) {
                return new Response(JSON.stringify({ 
                    success: false, 
                    message: `Limit request denied: You have already submitted a request for ${type} this month. Current status is '${existingReq.status}'. Only one request per category is allowed per month.` 
                }), { status: 400, headers });
            }

            // Save request securely. Only `managerId` can approve this later.
            try {
                await env.DB.prepare(`
                    INSERT INTO limit_approval_requests (user_id, manager_id, request_type, requested_value, status, for_month, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'Pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).bind(userId, managerId, type, parsedAmount, reqMonth).run();
            } catch (dbErr) {
                console.error("SQLite INSERT into limit_approval_requests table failed:", dbErr.message);
                return new Response(JSON.stringify({ success: false, message: "Database Save Error: " + dbErr.message }), { status: 500, headers });
            }

            return new Response(JSON.stringify({ 
                success: true, 
                message: `Limit approval request for additional ${parsedAmount} ${type} successfully saved and sent specifically to your manager (${managerId}).` 
            }), { status: 200, headers });
        }


        /* ================================================================
           POST /api/expense
           Submit new expense (multipart/form-data)
           STRICT SUBMISSION LOCK if limits are exceeded without approval
        ================================================================ */
        if (path === "/api/expense" && method === "POST") {
            const formData = await request.formData();
            const userId = await resolveLoggedInUserId(request, url, null, formData);
            const expDate = formData.get("exp_date") || formData.get("expense_date");

            if (!userId) {
                return new Response(JSON.stringify({ success: false, message: "Unauthorized: User ID is missing. Please login again." }), { status: 401, headers });
            }

            if (isMissing(expDate)) {
                return new Response(JSON.stringify({ success: false, message: "Expense date is required." }), { status: 400, headers });
            }

            const existingExp = await env.DB.prepare(
                "SELECT exp_id FROM expense_master WHERE user_id = ? AND expense_date = ?"
            ).bind(userId, expDate).first();

            if (existingExp) {
                return new Response(JSON.stringify({
                    success: false,
                    message: `For this date (${expDate}) expense is already submitted.`
                }), { status: 400, headers });
            }

            const userApprovers = await env.DB.prepare(
                "SELECT level_first_approver, level_second_approver FROM user WHERE user_id = ?"
            ).bind(userId).first();

            if (!userApprovers) {
                return new Response(JSON.stringify({
                    success: false,
                    message: "Security Error: Invalid User ID. Only logged-in users can submit expenses."
                }), { status: 403, headers });
            }

            // Bind the correct strict level approvers into the master record
            const l1_app = userApprovers.level_first_approver;
            const l2_app = userApprovers.level_second_approver;

            const itiStr = formData.get("itineraries");
            let itineraries = [];
            let total_da = 0, total_hotel = 0, total_other = 0;
            let total_assigned = 0, total_completed = 0, total_pms = 0, total_asset = 0;

            if (itiStr) {
                try {
                    itineraries = JSON.parse(itiStr);
                } catch {
                    return new Response(JSON.stringify({ success: false, message: "Invalid itineraries payload." }), { status: 400, headers });
                }

                for (const iti of itineraries) {
                    total_da += parseFloat(iti.da || 0);
                    total_hotel += parseFloat(iti.hotel || 0);
                    total_other += parseFloat(iti.oth_amount || 0);
                    total_assigned += parseInt(iti.ws_assigned || 0, 10);
                    total_completed += parseInt(iti.ws_closed || 0, 10);
                    total_pms += parseInt(iti.ws_pms || 0, 10);
                    total_asset += parseInt(iti.ws_asset || 0, 10);
                }
            }

            /* ── STRICT LIMIT VALIDATION CHECK ── */
            let incoming_km = 0;
            let incoming_auto = 0;
            for (const iti of itineraries) {
                if (iti.mode === 'Bike' || iti.mode === 'Car') {
                    incoming_km += parseFloat(iti.km || 0);
                }
                if (iti.mode === 'Auto') {
                    incoming_auto += parseFloat(iti.amount || 0);
                }
                if (iti.sub_mode === 'Auto') {
                    incoming_auto += parseFloat(iti.sub_amount || 0);
                }
            }

            const currentMonthStr = expDate.slice(0, 7); // 'YYYY-MM'

            const [accumulatedKmRow, accumulatedAutoRow, allowanceRow, approvedKmRequests, approvedAutoRequests] = await Promise.all([
                env.DB.prepare(`
                    SELECT COALESCE(SUM(i.distance_km), 0) as total_km 
                    FROM expense_itinerary i 
                    JOIN expense_master m ON i.exp_id = m.exp_id 
                    WHERE m.user_id = ? 
                      AND strftime('%Y-%m', m.expense_date) = ? 
                      AND (i.travel_mode = 'Bike' OR i.travel_mode = 'Car')
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_km: 0 })),
                
                env.DB.prepare(`
                    SELECT COALESCE(SUM(i.travel_amount), 0) + COALESCE(SUM(i.sub_amount), 0) as total_auto 
                    FROM expense_itinerary i 
                    JOIN expense_master m ON i.exp_id = m.exp_id 
                    WHERE m.user_id = ? 
                      AND strftime('%Y-%m', m.expense_date) = ? 
                      AND (i.travel_mode = 'Auto' OR i.sub_mode = 'Auto')
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_auto: 0 })),
                
                env.DB.prepare("SELECT max_km_per_month FROM allowance_master WHERE grade = (SELECT grade FROM user WHERE user_id = ?)").bind(userId).first().catch(() => null),
                
                env.DB.prepare(`
                    SELECT COALESCE(SUM(requested_value), 0) as total_approved_km 
                    FROM limit_approval_requests 
                    WHERE user_id = ? AND request_type = 'KM' AND LOWER(status) = 'approved' 
                      AND for_month = ?
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_approved_km: 0 })),
                
                env.DB.prepare(`
                    SELECT COALESCE(SUM(requested_value), 0) as total_approved_auto 
                    FROM limit_approval_requests 
                    WHERE user_id = ? AND request_type = 'AUTO' AND LOWER(status) = 'approved' 
                      AND for_month = ?
                `).bind(userId, currentMonthStr).first().catch(() => ({ total_approved_auto: 0 }))
            ]);

            const max_km_per_month = allowanceRow ? (allowanceRow.max_km_per_month || 2000) : 2000;
            const max_auto_per_month = 1000;

            const current_accumulated_km = accumulatedKmRow ? (accumulatedKmRow.total_km || 0) : 0;
            const projected_total_km = current_accumulated_km + incoming_km;

            if (projected_total_km > max_km_per_month) {
                const excess_km = projected_total_km - max_km_per_month;
                const approved_km_limit = approvedKmRequests ? (approvedKmRequests.total_approved_km || 0) : 0;
                
                if (approved_km_limit < excess_km) {
                    const missing_km = excess_km - approved_km_limit;
                    return new Response(JSON.stringify({ 
                        success: false, 
                        message: `Submission Locked: You have exceeded your monthly KM limit by ${missing_km.toFixed(2)} km. You must request approval from your Level 1 Manager to proceed.` 
                    }), { status: 400, headers });
                }
            }

            const current_accumulated_auto = accumulatedAutoRow ? (accumulatedAutoRow.total_auto || 0) : 0;
            const projected_total_auto = current_accumulated_auto + incoming_auto;

            if (projected_total_auto > max_auto_per_month) {
                const excess_auto = projected_total_auto - max_auto_per_month;
                const approved_auto_limit = approvedAutoRequests ? (approvedAutoRequests.total_approved_auto || 0) : 0;
                
                if (approved_auto_limit < excess_auto) {
                    const missing_auto = excess_auto - approved_auto_limit;
                    return new Response(JSON.stringify({ 
                        success: false, 
                        message: `Submission Locked: You have exceeded your monthly Auto limit by ₹${missing_auto.toFixed(2)}. You must request approval from your Level 1 Manager to proceed.` 
                    }), { status: 400, headers });
                }
            }

            /* ── SUBMIT TRANSACTION EXECUTION ── */
            let finalExpId = "RJ-00/00-000000";
            try {
                const dateObj = new Date(expDate);
                const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
                const yy = String(dateObj.getFullYear()).slice(-2);
                const monthPrefix = `${mm}/${yy}`;

                let seqNum = 1;
                try {
                    // Start Sequence precisely per month by searching MAX value 
                    const maxSeqRes = await env.DB.prepare(`
                        SELECT exp_id FROM expense_master 
                        WHERE exp_id LIKE ? 
                    `).bind(`RJ-${monthPrefix}-%`).all();

                    let maxSeq = 0;
                    if (maxSeqRes && maxSeqRes.results) {
                        for (const row of maxSeqRes.results) {
                            const parts = row.exp_id.split('-');
                            if (parts.length === 3) {
                                const num = parseInt(parts[2], 10);
                                if (!isNaN(num) && num > maxSeq) {
                                    maxSeq = num;
                                }
                            }
                        }
                    }
                    seqNum = maxSeq + 1;
                } catch (e) {
                    console.error("Monthly sequence fetch error:", e.message);
                }

                let candidate = `RJ-${monthPrefix}-${String(seqNum).padStart(6, "0")}`;
                let attempts = 0;
                while (attempts < 10) {
                    const exists = await env.DB.prepare(
                        "SELECT exp_id FROM expense_master WHERE exp_id = ?"
                    ).bind(candidate).first().catch(() => null);
                    if (!exists) { finalExpId = candidate; break; }
                    seqNum++;
                    attempts++;
                    candidate = `RJ-${monthPrefix}-${String(seqNum).padStart(6, "0")}`;
                }
                
                if (finalExpId === "RJ-00/00-000000") {
                    finalExpId = `RJ-${monthPrefix}-${Date.now().toString().slice(-8)}`;
                }
            } catch (e) {
                console.error("Sequence ID generation error:", e.message);
            }

            try {
                await env.DB.prepare(
                    "ALTER TABLE expense_itinerary ADD COLUMN visit_purpose TEXT"
                ).run();
            } catch (_) {}

            await env.DB.prepare(`
                INSERT INTO expense_master (
                    exp_id, user_id, expense_date, total_amount, status,
                    level_first_approver, level_second_approver,
                    da_amount, hotel_amount, other_expense_amount,
                    calls_assigned, calls_completed, pms_count, asset_tagging
                )
                VALUES (?, ?, ?, ?, 'Pending L1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                finalExpId, userId, expDate, formData.get("total_amount"),
                l1_app, l2_app,
                total_da, total_hotel, total_other,
                total_assigned, total_completed, total_pms, total_asset
            ).run();

            const r2Domain = env.R2_PUBLIC_DOMAIN || "https://pub-cyrixapp.r2.dev";

            const uploadFile = async (fileKey, type, itiId = null) => {
                const file = formData.get(fileKey);
                if (file && file.size > 0 && env.BILLS_BUCKET) {
                    const safeName = String(file.name || "file").replace(/\s+/g, "_");
                    const fileName = `bills/${finalExpId}_${type}_${Date.now()}_${safeName}`;
                    await env.BILLS_BUCKET.put(fileName, file.stream());
                    await env.DB.prepare(
                        "INSERT INTO expense_attachments (exp_id, itinerary_id, bill_type, file_url) VALUES (?, ?, ?, ?)"
                    ).bind(finalExpId, itiId, type, `${r2Domain}/${fileName}`).run();
                }
            };

            for (const iti of itineraries) {
                const itiId = `${finalExpId}-${iti.leg}`;
                const fromDistrict = iti.travel_type === "Outdoor"
                    ? (iti.district_from || iti.district)
                    : iti.district;

                await env.DB.prepare(`
                    INSERT INTO expense_itinerary (
                        itinerary_id, exp_id, leg_number,
                        from_district, to_district,
                        from_location, to_location,
                        travel_mode, distance_km, travel_amount,
                        sub_mode, sub_amount,
                        da_amount, hotel_amount,
                        other_desc, other_amount,
                        calls_assigned, calls_completed, pms_count, asset_tagging,
                        visit_purpose
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    itiId, finalExpId, iti.leg,
                    fromDistrict, iti.district,
                    iti.from, iti.to,
                    iti.mode, iti.km, iti.amount,
                    iti.sub_mode, iti.sub_amount,
                    iti.da, iti.hotel,
                    iti.oth_desc, iti.oth_amount,
                    iti.ws_assigned, iti.ws_closed, iti.ws_pms, iti.ws_asset,
                    iti.visit_purpose
                ).run();

                if (iti.travel_type === "Outdoor") await uploadFile(`comm_mail_${iti.leg}`, "Communication_Mail", itiId);
                await uploadFile(`main_bill_${iti.leg}`, iti.mode, itiId);
                if (iti.sub_mode) await uploadFile(`sub_bill_${iti.leg}`, iti.sub_mode, itiId);
                if (iti.leg === 1) await uploadFile("hotel_bill_1", "Hotel", itiId);
                await uploadFile(`oth_bill_${iti.leg}`, "Other_Expense", itiId);
            }

            return new Response(JSON.stringify({
                success: true,
                message: "Expense submitted successfully.",
                exp_id: finalExpId
            }), { status: 200, headers });
        }

        return new Response(JSON.stringify({ success: false, message: "Route Not Found" }), { status: 404, headers });
    } catch (e) {
        return new Response(JSON.stringify({
            success: false,
            message: "System Error: " + e.message
        }), { status: 500, headers });
    }
}
