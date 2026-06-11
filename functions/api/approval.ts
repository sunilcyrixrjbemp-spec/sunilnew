interface Env {
  DB: D1Database;
  BILLS_BUCKET: R2Bucket;
  CYRIXAPP?: R2Bucket;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function resolveLoggedInUserId(request: Request, url: URL, body: any = null) {
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

async function getApproverInfo(env: Env, requesterId: string, expId: string | null = null) {
  const requester: any = await env.DB.prepare("SELECT user_id, role FROM user WHERE user_id = ?").bind(requesterId).first();
  if (!requester) return null;

  const isAdmin = (requester.role || "") === "Admin" || (requester.role || "") === "Superadmin";
  let isL1 = false;
  let isL2 = false;

  if (expId) {
    const exp: any = await env.DB.prepare("SELECT level_first_approver, level_second_approver FROM expense_master WHERE exp_id = ?").bind(expId).first();
    if (exp) {
      isL1 = exp.level_first_approver === requesterId;
      isL2 = exp.level_second_approver === requesterId;
    }
  } else {
    const l1Check = await env.DB.prepare("SELECT exp_id FROM expense_master WHERE level_first_approver = ? LIMIT 1").bind(requesterId).first().catch(() => null);
    const l2Check = await env.DB.prepare("SELECT exp_id FROM expense_master WHERE level_second_approver = ? LIMIT 1").bind(requesterId).first().catch(() => null);
    const limitCheck = await env.DB.prepare("SELECT id FROM limit_approval_requests WHERE manager_id = ? LIMIT 1").bind(requesterId).first().catch(() => null);
    
    isL1 = !!l1Check || !!limitCheck;
    isL2 = !!l2Check;
  }

  return { isAdmin, isL1, isL2, role: requester.role };
}

async function canAccessApprovalCenter(env: Env, requesterId: string) {
  const info = await getApproverInfo(env, requesterId, null);
  if (!info) return false;
  if (info.isAdmin) return true; 

  const managerRoles = ["Manager", "HOD", "Accounts", "Senior Manager", "ZSM", "RSM", "ASM"];
  const hasRole = managerRoles.some(r => (info.role || "").toLowerCase().includes(r.toLowerCase()));
  return hasRole || info.isL1 || info.isL2;
}

function deriveActionLevel(expense: any) {
  const status = (expense.status || "").toLowerCase();
  if (status === "pending l2") return "L2";
  if (status === "pending l1" || status === "pending") return "L1";

  if (status === "rejected" || status === "approved") {
    if (!isMissing(expense.approved_by)) {
      if (expense.approved_by === expense.level_second_approver) return "L2";
      if (expense.approved_by === expense.level_first_approver) return "L1";
    }
  }
  return null;
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
    /* ── GET /api/approval/image ── */
    if (path === "/api/approval/image" && method === "GET") {
      let objectKey = url.searchParams.get("key");
      const rawUrl  = url.searchParams.get("url");

      if (!objectKey && rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          objectKey = parsed.pathname.replace(/^\//, "");
        } catch {
          objectKey = rawUrl; 
        }
      }

      if (!objectKey) {
        return new Response(JSON.stringify({ success: false, message: "Missing 'key' or 'url' parameter." }), { status: 400, headers });
      }

      const userId = await resolveLoggedInUserId(request, url);
      if (!userId) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized." }), { status: 401, headers });
      }

      const r2Bucket = env.BILLS_BUCKET || env.CYRIXAPP;
      if (!r2Bucket) {
        return new Response(JSON.stringify({ success: false, message: "Storage configuration issue." }), { status: 500, headers });
      }

      const r2Object = await r2Bucket.get(objectKey);
      if (!r2Object) {
        return new Response(JSON.stringify({ success: false, message: "Image not found." }), { status: 404, headers });
      }

      let contentType = r2Object.httpMetadata?.contentType || "";
      if (!contentType) {
        const ext = objectKey.split(".").pop()?.toLowerCase() || "";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif",  webp: "image/webp", pdf: "application/pdf",
          svg: "image/svg+xml"
        };
        contentType = mimeMap[ext] || "application/octet-stream";
      }

      return new Response(r2Object.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=3600, s-maxage=86400",
          "Content-Disposition": "inline",
        }
      });
    }

    /* ── GET /api/approval/list ── */
    if (path === "/api/approval/list" && method === "GET") {
      const userId = await resolveLoggedInUserId(request, url);
      if (!userId) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized: Please login first." }), { status: 401, headers });
      }

      const hasAccess = await canAccessApprovalCenter(env, userId);
      if (!hasAccess) {
        return new Response(JSON.stringify({ success: false, message: "Access Denied: Only managers/approvers can access." }), { status: 403, headers });
      }

      const currentMonth = new Date().toISOString().slice(0, 7);

      const expQuery = `
        SELECT m.exp_id, m.user_id, m.expense_date, m.total_amount, m.status,
               m.da_amount, m.hotel_amount, m.other_expense_amount,
               m.level_first_approver, m.level_second_approver,
               m.approved_by, m.reject_reason, m.created_at as submitted_at,
               u.full_name, u.e_code, u.grade, u.district_name,
               (SELECT GROUP_CONCAT(DISTINCT i.to_district) FROM expense_itinerary i WHERE i.exp_id = m.exp_id) as district
        FROM expense_master m 
        JOIN user u ON m.user_id = u.user_id 
        WHERE 
            ((m.status = 'Pending L1' OR m.status = 'Pending') AND m.level_first_approver = ?) 
            OR 
            (m.status = 'Pending L2' AND m.level_second_approver = ?)
            OR
            (strftime('%Y-%m', m.expense_date) = ? AND (m.level_first_approver = ? OR m.level_second_approver = ?))
        ORDER BY m.created_at DESC
      `;
      
      const { results: expensesResult }: any = await env.DB.prepare(expQuery)
        .bind(userId, userId, currentMonth, userId, userId)
        .all().catch(() => ({ results: [] }));

      const limQuery = `
        SELECT l.id, l.request_type, l.requested_value, l.status, l.created_at, u.full_name, u.e_code 
        FROM limit_approval_requests l 
        JOIN user u ON l.user_id = u.user_id 
        WHERE l.manager_id = ? 
        AND (LOWER(l.status) = 'pending' OR strftime('%Y-%m', l.created_at) = ?)
        ORDER BY l.created_at DESC
      `;
      const { results: limitsResult }: any = await env.DB.prepare(limQuery).bind(userId, currentMonth).all().catch(() => ({ results: [] }));

      const combined: any[] = [];

      for (const e of (expensesResult || [])) {
        let canAction = false;
        let actionLevel = deriveActionLevel(e);

        if ((e.status === "Pending L1" || e.status === "Pending") && e.level_first_approver === userId) {
          canAction = true;
          actionLevel = "L1";
        } else if (e.status === "Pending L2" && e.level_second_approver === userId) {
          canAction = true;
          actionLevel = "L2";
        }

        combined.push({
          type: 'Expense',
          id: e.exp_id,
          full_name: e.full_name,
          e_code: e.e_code,
          district: e.district,
          date: e.expense_date,
          amount: e.total_amount,
          status: e.status,
          can_action: canAction, 
          action_level: actionLevel,
          submitted_at: e.submitted_at,
          sort_date: e.submitted_at
        });
      }

      for (const l of (limitsResult || [])) {
        const canAction = l.status.toLowerCase() === 'pending';
        combined.push({
          type: 'Limit',
          id: 'REQ-' + l.id,
          req_type: l.request_type,
          full_name: l.full_name,
          e_code: l.e_code,
          district: 'N/A',
          date: l.created_at,
          amount: l.requested_value,
          status: l.status.charAt(0).toUpperCase() + l.status.slice(1),
          can_action: canAction,
          action_level: 'L1',
          submitted_at: l.created_at,
          sort_date: l.created_at
        });
      }

      combined.sort((a, b) => new Date(b.sort_date).getTime() - new Date(a.sort_date).getTime());
      return new Response(JSON.stringify({ success: true, expenses: combined }), { status: 200, headers });
    }

    /* ── GET /api/approval/detail ── */
    if (path === "/api/approval/detail" && method === "GET") {
      const userId = await resolveLoggedInUserId(request, url);
      const id = url.searchParams.get("id") || url.searchParams.get("exp_id"); 
      const type = url.searchParams.get("type") || 'Expense'; 

      if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });
      if (!id) return new Response(JSON.stringify({ success: false, message: "ID is required." }), { status: 400, headers });

      if (type === 'Limit') {
        const reqId = id.replace('REQ-', '');
        const req = await env.DB.prepare(`
          SELECT l.*, u.full_name, u.e_code, u.grade, u.district_name, u.mobile_number 
          FROM limit_approval_requests l
          JOIN user u ON l.user_id = u.user_id
          WHERE l.id = ? AND l.manager_id = ?
        `).bind(reqId, userId).first();

        if (!req) return new Response(JSON.stringify({ success: false, message: "Access denied." }), { status: 403, headers });

        return new Response(JSON.stringify({
          success: true,
          type: 'Limit',
          request: req,
          can_action: (req.status as string).toLowerCase() === 'pending'
        }), { status: 200, headers });
      } else {
        const exp: any = await env.DB.prepare(`
          SELECT m.*, 
                 m.level_first_approver_time as l1_action_date,
                 m.level_second_approver_time as l2_action_date,
                 u.full_name, u.e_code, u.grade, u.designation, u.district_name, u.mobile_number,
                 (SELECT full_name FROM user WHERE user_id = m.level_first_approver) as l1_name,
                 (SELECT full_name FROM user WHERE user_id = m.level_second_approver) as l2_name
          FROM expense_master m
          JOIN user u ON m.user_id = u.user_id
          WHERE m.exp_id = ?
        `).bind(id).first();

        if (!exp) return new Response(JSON.stringify({ success: false, message: "Expense not found." }), { status: 404, headers });

        const isL1 = exp.level_first_approver === userId;
        const isL2 = exp.level_second_approver === userId;
        const l2CannotSee = isL2 && (exp.status === 'Pending L1' || exp.status === 'Pending') && !isL1;

        if ((!isL1 && !isL2) || l2CannotSee) {
          return new Response(JSON.stringify({ success: false, message: "Access Denied." }), { status: 403, headers });
        }

        let can_action = false;
        let userActionLevel = null;
        if ((exp.status === 'Pending L1' || exp.status === 'Pending') && exp.level_first_approver === userId) {
          can_action = true;
          userActionLevel = "L1";
        } else if (exp.status === 'Pending L2' && exp.level_second_approver === userId) {
          can_action = true;
          userActionLevel = "L2";
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
        `).bind(id).all();

        (itineraries || []).forEach((leg: any) => {
          const attachments: any[] = [];
          if (leg.attachments_raw) {
            leg.attachments_raw.split("|||").filter(Boolean).forEach((raw: any) => {
              const [url_val, bill_type] = raw.split("::");
              if (url_val) attachments.push({
                bill_type: bill_type || "",
                url: `/api/approval/image?url=${encodeURIComponent(url_val)}&user_id=${userId}`,
                raw_url: url_val
              });
            });
          }
          leg.attachments = attachments;
          leg.attachments_raw = undefined;
          leg.travel_type = leg.from_district !== leg.to_district ? "Outdoor" : "In-District";
          leg.ws_assigned = leg.calls_assigned ?? 0;
          leg.ws_closed   = leg.calls_completed ?? 0;
          leg.ws_pms      = leg.pms_count ?? 0;
          leg.ws_asset    = leg.asset_tagging ?? 0;
        });

        return new Response(JSON.stringify({
          success: true,
          type: 'Expense',
          expense: { ...exp, action_level: deriveActionLevel(exp) },
          itineraries,
          can_action,
          action_level: userActionLevel
        }), { status: 200, headers });
      }
    }

    /* ── POST /api/approval/action ── */
    if (path === "/api/approval/action" && method === "POST") {
      const body: any = await request.json();
      const userId = await resolveLoggedInUserId(request, url, body);

      if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });
      
      const { id, type, action, reason } = body; 
      const expId = id || body.exp_id;

      if (!expId || !action) return new Response(JSON.stringify({ success: false, message: "Invalid payload." }), { status: 400, headers });

      if (type === 'Limit') {
        const reqId = expId.replace('REQ-', '');
        const req: any = await env.DB.prepare("SELECT * FROM limit_approval_requests WHERE id = ? AND manager_id = ?").bind(reqId, userId).first();
        
        if (!req) return new Response(JSON.stringify({ success: false, message: "Access Denied." }), { status: 403, headers });
        if (req.status.toLowerCase() !== 'pending') return new Response(JSON.stringify({ success: false, message: "Already processed." }), { status: 400, headers });

        await env.DB.prepare("UPDATE limit_approval_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(action, reqId).run();
        return new Response(JSON.stringify({ success: true, message: `Limit extension successfully ${action.toLowerCase()}.` }), { status: 200, headers });
      } else {
        const exp: any = await env.DB.prepare("SELECT * FROM expense_master WHERE exp_id = ?").bind(expId).first();
        if (!exp) return new Response(JSON.stringify({ success: false, message: "Expense not found." }), { status: 404, headers });

        const currentStatus = exp.status || "";
        if (currentStatus === "Approved" || currentStatus === "Rejected") {
          return new Response(JSON.stringify({ success: false, message: `This expense is already ${currentStatus}.` }), { status: 409, headers });
        }

        if (currentStatus === "Pending L1" || currentStatus === "Pending") {
          if (exp.level_first_approver !== userId) return new Response(JSON.stringify({ success: false, message: "Access Denied." }), { status: 403, headers });
          
          if (action === "Rejected") {
            if (!reason.trim()) return new Response(JSON.stringify({ success: false, message: "Reason required." }), { status: 400, headers });
            await env.DB.prepare("UPDATE expense_master SET status = 'Rejected', reject_reason = ?, approved_by = ?, level_first_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(reason, userId, expId).run();
            return new Response(JSON.stringify({ success: true, message: "Expense rejected at Level 1." }), { status: 200, headers });
          } else {
            const newStatus = (!isMissing(exp.level_second_approver) && exp.level_second_approver !== 'None') ? "Pending L2" : "Approved";
            await env.DB.prepare("UPDATE expense_master SET status = ?, approved_by = ?, level_first_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(newStatus, userId, expId).run();
            return new Response(JSON.stringify({ success: true, message: "Approved." }), { status: 200, headers });
          }
        } 
        else if (currentStatus === "Pending L2") {
          if (exp.level_second_approver !== userId) return new Response(JSON.stringify({ success: false, message: "Access Denied." }), { status: 403, headers });

          if (action === "Rejected") {
            if (!reason.trim()) return new Response(JSON.stringify({ success: false, message: "Reason required." }), { status: 400, headers });
            await env.DB.prepare("UPDATE expense_master SET status = 'Rejected', reject_reason = ?, approved_by = ?, level_second_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(reason, userId, expId).run();
            return new Response(JSON.stringify({ success: true, message: "Expense rejected at Level 2." }), { status: 200, headers });
          } else {
            await env.DB.prepare("UPDATE expense_master SET status = 'Approved', approved_by = ?, level_second_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(userId, expId).run();
            return new Response(JSON.stringify({ success: true, message: "Expense fully approved." }), { status: 200, headers });
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: false, message: "Route Not Found" }), { status: 404, headers });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, message: "System Error: " + e.message }), { status: 500, headers });
  }
};
