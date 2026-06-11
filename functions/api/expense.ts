interface Env {
  DB: D1Database;
  BILLS_BUCKET: R2Bucket;
  R2_PUBLIC_DOMAIN?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id",
};

function isMissing(value: any) {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "" || normalized === "null" || normalized === "undefined";
}

function getCookieValue(cookieHeader: string | null, key: string) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function decodeJwtPayload(token: string) {
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

async function resolveLoggedInUserId(request: Request, url: URL, body: any = null, formData: FormData | null = null) {
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

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const headers = { ...corsHeaders, "Content-Type": "application/json" };

  if (method === "OPTIONS") {
    return new Response(null, { headers });
  }

  try {
    /* ── GET /api/expense/init ── */
    if (path === "/api/expense/init" && method === "GET") {
      const userId = await resolveLoggedInUserId(request, url);
      if (!userId) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized: Please login first." }), { status: 401, headers });
      }

      const reqMonth = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);

      const [user, kmRes, autoRes, facResList, submittedRes, approvedKmReq, approvedAutoReq, existingKmMonth, existingAutoMonth]: any[] = await Promise.all([
        env.DB.prepare("SELECT full_name, e_code, grade, district_name as home_district, level_first_approver, level_second_approver FROM user WHERE user_id = ?").bind(userId).first(),
        env.DB.prepare(`SELECT SUM(distance_km) as total_km FROM expense_itinerary i JOIN expense_master m ON i.exp_id = m.exp_id WHERE m.user_id = ? AND strftime('%Y-%m', m.expense_date) = ? AND (i.travel_mode = 'Bike' OR i.travel_mode = 'Car')`).bind(userId, reqMonth).first().catch(() => ({ total_km: 0 })),
        env.DB.prepare(`SELECT COALESCE(SUM(i.travel_amount), 0) + COALESCE(SUM(i.sub_amount), 0) as total_auto FROM expense_itinerary i JOIN expense_master m ON i.exp_id = m.exp_id WHERE m.user_id = ? AND strftime('%Y-%m', m.expense_date) = ? AND (i.travel_mode = 'Auto' OR i.sub_mode = 'Auto')`).bind(userId, reqMonth).first().catch(() => ({ total_auto: 0 })),
        env.DB.prepare('SELECT district_name, facility_name FROM "Facily Details"').all().catch(() => ({ results: [] })),
        env.DB.prepare("SELECT expense_date FROM expense_master WHERE user_id = ? AND strftime('%Y-%m', expense_date) = ?").bind(userId, reqMonth).all().catch(() => ({ results: [] })),
        env.DB.prepare(`SELECT COALESCE(SUM(requested_value), 0) as approved_km FROM limit_approval_requests WHERE user_id = ? AND request_type = 'KM' AND LOWER(status) = 'approved' AND for_month = ?`).bind(userId, reqMonth).first().catch(() => ({ approved_km: 0 })),
        env.DB.prepare(`SELECT COALESCE(SUM(requested_value), 0) as approved_auto FROM limit_approval_requests WHERE user_id = ? AND request_type = 'AUTO' AND LOWER(status) = 'approved' AND for_month = ?`).bind(userId, reqMonth).first().catch(() => ({ approved_auto: 0 })),
        env.DB.prepare(`SELECT status, requested_value FROM limit_approval_requests WHERE user_id = ? AND request_type = 'KM' AND for_month = ? ORDER BY id DESC LIMIT 1`).bind(userId, reqMonth).first().catch(() => null),
        env.DB.prepare(`SELECT status, requested_value FROM limit_approval_requests WHERE user_id = ? AND request_type = 'AUTO' AND for_month = ? ORDER BY id DESC LIMIT 1`).bind(userId, reqMonth).first().catch(() => null)
      ]);

      if (!user) {
        return new Response(JSON.stringify({ success: false, message: "Invalid User: You don't have access to submit expenses." }), { status: 403, headers });
      }

      let allowance: any = await env.DB.prepare("SELECT * FROM allowance_master WHERE grade = ?").bind(user.grade).first().catch(() => null);
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
      }

      allowance.current_month_km = kmRes ? (kmRes.total_km || 0) : 0;
      allowance.current_month_auto = autoRes ? (autoRes.total_auto || 0) : 0;
      allowance.max_auto_per_month = 1000;

      const facilities: Record<string, string[]> = {};
      if (facResList && facResList.results) {
        facResList.results.forEach((f: any) => {
          if (!facilities[f.district_name]) facilities[f.district_name] = [];
          facilities[f.district_name].push(f.facility_name);
        });
      }

      const submitted_dates = submittedRes && submittedRes.results
        ? submittedRes.results.map((r: any) => r.expense_date)
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

    /* ── GET /api/expense/edit ── */
    if (path === "/api/expense/edit" && method === "GET") {
      const userId = await resolveLoggedInUserId(request, url);
      const expId = url.searchParams.get("exp_id");

      if (!userId) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized." }), { status: 401, headers });
      }
      if (!expId) {
        return new Response(JSON.stringify({ success: false, message: "exp_id is required." }), { status: 400, headers });
      }

      const expense: any = await env.DB.prepare(`
        SELECT m.*, u.full_name, u.e_code, u.grade, u.district_name as home_district
        FROM expense_master m
        JOIN user u ON m.user_id = u.user_id
        WHERE m.exp_id = ?
      `).bind(expId).first();

      if (!expense) {
        return new Response(JSON.stringify({ success: false, message: "Expense not found." }), { status: 404, headers });
      }

      if (expense.user_id !== userId) {
        return new Response(JSON.stringify({ success: false, message: "Access Denied." }), { status: 403, headers });
      }

      const { results: itineraries }: any = await env.DB.prepare(`
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

      const enrichedItineraries = (itineraries || []).map((leg: any) => {
        const attachments: any[] = [];
        if (leg.attachments_raw) {
          leg.attachments_raw.split("|||").filter(Boolean).forEach((raw: any) => {
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
          attachments
        };
      });

      return new Response(JSON.stringify({
        success: true,
        expense,
        itineraries: enrichedItineraries
      }), { status: 200, headers });
    }

    /* ── POST /api/expense/limit-request ── */
    if (path === "/api/expense/limit-request" && method === "POST") {
      let userId = null;
      let type = null;
      let amount = null;
      let reqMonth = null;

      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body: any = await request.json().catch(() => ({}));
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

      if (!userId) {
        userId = await resolveLoggedInUserId(request, url);
      }

      if (!userId) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized: Please login first." }), { status: 401, headers });
      }

      if (isMissing(type) || isMissing(amount)) {
        return new Response(JSON.stringify({ success: false, message: "Type and amount are required." }), { status: 400, headers });
      }

      const parsedAmount = parseFloat(String(amount));
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return new Response(JSON.stringify({ success: false, message: "Invalid amount." }), { status: 400, headers });
      }

      const user: any = await env.DB.prepare("SELECT level_first_approver FROM user WHERE user_id = ?").bind(userId).first();
      if (!user) {
        return new Response(JSON.stringify({ success: false, message: "User not found." }), { status: 404, headers });
      }

      const managerId = user.level_first_approver;
      if (isMissing(managerId)) {
        return new Response(JSON.stringify({ success: false, message: "No manager mapped to your profile." }), { status: 400, headers });
      }
      
      const existingReq: any = await env.DB.prepare(`
        SELECT id, status FROM limit_approval_requests 
        WHERE user_id = ? AND request_type = ? AND for_month = ?
      `).bind(userId, type, reqMonth).first().catch(() => null);

      if (existingReq) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `Request for ${type} already exists this month (Status: ${existingReq.status}).` 
        }), { status: 400, headers });
      }

      await env.DB.prepare(`
        INSERT INTO limit_approval_requests (user_id, manager_id, request_type, requested_value, status, for_month, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'Pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(userId, managerId, type, parsedAmount, reqMonth).run();

      return new Response(JSON.stringify({ 
        success: true, 
        message: `Limit approval request submitted to manager ${managerId}.` 
      }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ success: false, message: "Route not found" }), { status: 404, headers });

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers });
  }
};
