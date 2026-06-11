interface Env {
  DB: D1Database;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

async function resolveLoggedInUserId(request: Request, url: URL) {
  const candidates = [
    url.searchParams.get("user_id"),
    request.headers.get("x-user-id"),
    request.headers.get("cf-user-id")
  ];

  const cookieHeader = request.headers.get("cookie") || "";
  candidates.push(getCookieValue(cookieHeader, "user_id"));

  const authHeader = request.headers.get("Authorization") || request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const payload = decodeJwtPayload(authHeader.slice(7).trim());
    if (payload) candidates.push(payload.user_id, payload.uid);
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
    /* ── GET /api/home/list ── */
    if (path === "/api/home/list" && method === "GET") {
      const userId = await resolveLoggedInUserId(request, url);
      const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
      
      if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });

      const user: any = await env.DB.prepare("SELECT role FROM user WHERE user_id = ?").bind(userId).first();
      if (!user) return new Response(JSON.stringify({ success: false, message: "User not found" }), { status: 404, headers });

      const isAdmin = user.role === "Admin" || user.role === "Superadmin";

      let query = `
        SELECT m.exp_id as id, m.expense_date as date, m.total_amount as amount, m.status,
               u.full_name, u.e_code
        FROM expense_master m
        JOIN user u ON m.user_id = u.user_id
        WHERE strftime('%Y-%m', m.expense_date) = ?
      `;
      let bindings: any[] = [month];

      if (isAdmin) {
        query += ` AND (m.user_id = ? OR m.level_first_approver = ?)`;
        bindings.push(userId, userId);
      } else {
        query += ` AND m.user_id = ?`;
        bindings.push(userId);
      }

      query += ` ORDER BY m.created_at DESC`;

      const { results } = await env.DB.prepare(query).bind(...bindings).all();
      return new Response(JSON.stringify({ success: true, expenses: results || [] }), { status: 200, headers });
    }

    /* ── GET /api/approval/list ── */
    if (path === "/api/approval/list" && method === "GET") {
      const userId = await resolveLoggedInUserId(request, url);
      const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
      const status = url.searchParams.get("status") || "All";
      
      if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });

      const user: any = await env.DB.prepare("SELECT role FROM user WHERE user_id = ?").bind(userId).first();
      if (!user) return new Response(JSON.stringify({ success: false, message: "User not found" }), { status: 404, headers });

      let query = `
        SELECT m.exp_id as id, m.expense_date as date, m.total_amount as amount, m.status,
               m.level_first_approver, m.level_second_approver,
               u.full_name, u.e_code
        FROM expense_master m
        JOIN user u ON m.user_id = u.user_id
        WHERE strftime('%Y-%m', m.expense_date) = ?
      `;
      let bindings: any[] = [month];

      if (user.role === 'Manager') {
        query += ` AND m.level_first_approver = ?`;
        bindings.push(userId);
      } else if (user.role === 'Coordinator') {
        query += ` AND m.level_second_approver = ?`;
        bindings.push(userId);
      } else if (user.role === 'Admin' || user.role === 'Superadmin') {
        // Admins see all expenses
      } else {
        return new Response(JSON.stringify({ success: true, expenses: [] }), { status: 200, headers });
      }

      if (status !== "All") {
        query += ` AND m.status = ?`;
        bindings.push(status);
      }

      query += ` ORDER BY m.created_at DESC`;

      const { results } = await env.DB.prepare(query).bind(...bindings).all();
      return new Response(JSON.stringify({ success: true, expenses: results || [] }), { status: 200, headers });
    }

    /* ── GET /api/home/detail ── */
    if (path === "/api/home/detail" && method === "GET") {
      const userId = await resolveLoggedInUserId(request, url);
      const expId = url.searchParams.get("exp_id");

      if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });
      if (!expId) return new Response(JSON.stringify({ success: false, message: "exp_id required" }), { status: 400, headers });

      const user: any = await env.DB.prepare("SELECT role FROM user WHERE user_id = ?").bind(userId).first();
      const isAdmin = user && (user.role === "Admin" || user.role === "Superadmin");

      const exp: any = await env.DB.prepare(`
        SELECT m.*, u.full_name, u.e_code, u.grade, u.designation, u.district_name, u.mobile_number,
               (SELECT full_name FROM user WHERE user_id = m.level_first_approver) as l1_name,
               (SELECT full_name FROM user WHERE user_id = m.level_second_approver) as l2_name
        FROM expense_master m
        JOIN user u ON m.user_id = u.user_id
        WHERE m.exp_id = ?
      `).bind(expId).first();

      if (!exp) return new Response(JSON.stringify({ success: false, message: "Expense not found" }), { status: 404, headers });

      if (!isAdmin && exp.user_id !== userId && exp.level_first_approver !== userId && exp.level_second_approver !== userId) {
        return new Response(JSON.stringify({ success: false, message: "Access Denied" }), { status: 403, headers });
      }

      const { results: itineraries }: any = await env.DB.prepare(`
        SELECT i.*,
            COALESCE(
                (SELECT GROUP_CONCAT(a.file_url || '::' || a.bill_type, '|||')
                 FROM expense_attachments a WHERE a.itinerary_id = i.itinerary_id),
                ''
            ) as attachments_raw
        FROM expense_itinerary i
        WHERE i.exp_id = ? ORDER BY i.leg_number ASC
      `).bind(expId).all();

      const enrichedItineraries = (itineraries || []).map((leg: any) => {
        const attachments: any[] = [];
        if (leg.attachments_raw) {
          leg.attachments_raw.split("|||").filter(Boolean).forEach((raw: any) => {
            const [url_val, bill_type] = raw.split("::");
            if (url_val) attachments.push({ url: `/api/approval/image?url=${encodeURIComponent(url_val)}&user_id=${userId}`, bill_type: bill_type || "" });
          });
        }
        return {
          ...leg,
          travel_type: leg.from_district !== leg.to_district ? "Outdoor" : "In-District",
          ws_assigned: leg.calls_assigned ?? 0,
          ws_closed: leg.calls_completed ?? 0,
          ws_pms: leg.pms_count ?? 0,
          ws_asset: leg.asset_tagging ?? 0,
          attachments
        };
      });

      return new Response(JSON.stringify({
        success: true,
        type: 'Expense',
        expense: exp,
        itineraries: enrichedItineraries
      }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ success: false, message: "Route Not Found" }), { status: 404, headers });

  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, message: "System Error: " + e.message }), { status: 500, headers });
  }
};
