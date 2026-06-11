/**
 * ============================================================
 * CYRIX HEALTHCARE — APPROVAL CENTER BACKEND
 * File: approval.js
 * Worker: Cloudflare Workers + D1 (SQLite) + R2 (BILLS_BUCKET / cyrixapp)
 *
 * API Routes:
 * GET  /api/approval/list    → Pending Expenses & Limits for current approver
 * GET  /api/approval/detail  → Full detail: master + legs + attachments
 * GET  /api/approval/image   → R2 image proxy (in-app display, no external redirect)
 * POST /api/approval/action  → Approve / Reject (Strict level-enforced + Timestamp)
 * POST /api/approval/bulk-action → Approve multiple selected requests at once
 * POST /api/approval/edit    → Overwrite Expense Amounts + Work Summary + Add New Legs
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

async function getApproverInfo(env, requesterId, expId = null) {
    const requester = await env.DB.prepare(
        "SELECT user_id, role FROM user WHERE user_id = ?"
    ).bind(requesterId).first();

    if (!requester) return null;

    const isAdmin = (requester.role || "") === "Admin" || (requester.role || "") === "Superadmin";
    let isL1 = false;
    let isL2 = false;

    if (expId) {
        const exp = await env.DB.prepare(
            "SELECT level_first_approver, level_second_approver FROM expense_master WHERE exp_id = ?"
        ).bind(expId).first();
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

async function canAccessApprovalCenter(env, requesterId) {
    const info = await getApproverInfo(env, requesterId, null);
    if (!info) return false;
    if (info.isAdmin) return true; 

    const managerRoles = ["Manager", "HOD", "Accounts", "Senior Manager", "ZSM", "RSM", "ASM"];
    const hasRole = managerRoles.some(r => (info.role || "").toLowerCase().includes(r.toLowerCase()));
    return hasRole || info.isL1 || info.isL2;
}

function deriveActionLevel(expense) {
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

/* ── Main Handler ─────────────────────────────────────────── */

export default async function approvalHandler(request, env, corsHeaders) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {

        /* ================================================================
           GET /api/approval/image
           R2 image proxy
        ================================================================ */
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
                const ext = objectKey.split(".").pop().toLowerCase();
                const mimeMap = {
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


        /* ================================================================
           GET /api/approval/list
           Backend abhi bhi poora data (Pending, Approved, Rejected) fetch 
           karega jaisa aapne maanga tha. Frontend usey hide rakhega.
        ================================================================ */
        if (path === "/api/approval/list" && method === "GET") {
            const userId = await resolveLoggedInUserId(request, url);
            if (!userId) {
                return new Response(JSON.stringify({ success: false, message: "Unauthorized: Please login first." }), { status: 401, headers });
            }

            const hasAccess = await canAccessApprovalCenter(env, userId);
            if (!hasAccess) {
                return new Response(JSON.stringify({ success: false, message: "Access Denied: Only managers/approvers can access the Approval Center." }), { status: 403, headers });
            }

            const currentMonth = new Date().toISOString().slice(0, 7);

            const SELECT_COLS = `
                m.exp_id, m.user_id, m.expense_date, m.total_amount, m.status,
                m.da_amount, m.hotel_amount, m.other_expense_amount,
                m.level_first_approver, m.level_second_approver,
                m."approved_by", m.reject_reason, m.created_at as submitted_at,
                u.full_name, u.e_code, u.grade, u.district_name,
                (SELECT GROUP_CONCAT(DISTINCT i.to_district) FROM expense_itinerary i WHERE i.exp_id = m.exp_id) as district
            `;

            // Query fetches ALL pending items for the user + approved/rejected items for the current month
            const expQuery = `
                SELECT ${SELECT_COLS} 
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
            
            const { results: expensesResult } = await env.DB.prepare(expQuery)
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
            const { results: limitsResult } = await env.DB.prepare(limQuery).bind(userId, currentMonth).all().catch(() => ({ results: [] }));

            const combined = [];

            // Process Expenses
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
                    total_km: e.total_km,
                    status: e.status,
                    can_action: canAction, 
                    action_level: actionLevel,
                    submitted_at: e.submitted_at,
                    sort_date: e.submitted_at
                });
            }

            // Process Limits
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

            combined.sort((a, b) => new Date(b.sort_date) - new Date(a.sort_date));

            return new Response(JSON.stringify({ success: true, expenses: combined }), { status: 200, headers });
        }


        /* ================================================================
           GET /api/approval/detail
        ================================================================ */
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

                if (!req) {
                    return new Response(JSON.stringify({ success: false, message: "Request not found or access denied." }), { status: 403, headers });
                }

                return new Response(JSON.stringify({
                    success: true,
                    type: 'Limit',
                    request: req,
                    can_action: req.status.toLowerCase() === 'pending' && req.manager_id === userId
                }), { status: 200, headers });

            } else {
                // Modified Query to map action dates properly for frontend
                const exp = await env.DB.prepare(`
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

                // STRICT ROLE CHECK (L2 cannot see L1 pending)
                const isL1 = exp.level_first_approver === userId;
                const isL2 = exp.level_second_approver === userId;
                const l2CannotSee = isL2 && (exp.status === 'Pending L1' || exp.status === 'Pending') && !isL1;

                if ((!isL1 && !isL2) || l2CannotSee) {
                    return new Response(JSON.stringify({ success: false, message: "Access Denied: You are not assigned to approve this expense at its current stage." }), { status: 403, headers });
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
                `).bind(id).all();

                const attachmentMap = {};
                (itineraries || []).forEach(leg => {
                    const attachments = [];
                    if (leg.attachments_raw) {
                        leg.attachments_raw.split("|||").filter(Boolean).forEach(raw => {
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
                    expense: {
                        ...exp,
                        action_level: deriveActionLevel(exp)
                    },
                    itineraries: itineraries,
                    can_action,
                    action_level: userActionLevel
                }), { status: 200, headers });
            }
        }

        /* ================================================================
           POST /api/approval/bulk-action
        ================================================================ */
        if (path === "/api/approval/bulk-action" && method === "POST") {
            const body = await request.json();
            const userId = await resolveLoggedInUserId(request, url, body);

            if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });
            
            const { ids, action, reason } = body;
            if (!Array.isArray(ids) || ids.length === 0 || !action) {
                return new Response(JSON.stringify({ success: false, message: "Invalid payload." }), { status: 400, headers });
            }

            // Get Approver Name for professional message fallback
            const user = await env.DB.prepare("SELECT full_name, role FROM user WHERE user_id = ?").bind(userId).first();
            const approverName = user ? `${user.role} ${user.full_name}` : "Manager";

            let successCount = 0;
            let failCount = 0;

            for (const expId of ids) {
                try {
                    // Logic for Limits
                    if (String(expId).startsWith('REQ-')) {
                        const reqId = expId.replace('REQ-', '');
                        const req = await env.DB.prepare("SELECT status FROM limit_approval_requests WHERE id = ? AND manager_id = ?").bind(reqId, userId).first();
                        if (req && req.status.toLowerCase() === 'pending') {
                            await env.DB.prepare("UPDATE limit_approval_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(action, reqId).run();
                            successCount++;
                        } else {
                            failCount++;
                        }
                    } else {
                        // Logic for Expenses
                        const exp = await env.DB.prepare("SELECT status, level_first_approver, level_second_approver FROM expense_master WHERE exp_id = ?").bind(expId).first();
                        if (!exp) { failCount++; continue; }
                        
                        const currentStatus = exp.status || "";

                        if (action === "Rejected") {
                            const finalReason = reason || `Rejected by ${approverName} on ${new Date().toLocaleDateString('en-IN')}: No reason provided.`;

                            if (currentStatus === "Pending L1" || currentStatus === "Pending") {
                                if (exp.level_first_approver === userId) {
                                    await env.DB.prepare("UPDATE expense_master SET status = 'Rejected', reject_reason = ?, \"approved_by\" = ?, level_first_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(finalReason, userId, expId).run();
                                    successCount++;
                                } else { failCount++; }
                            } else if (currentStatus === "Pending L2") {
                                if (exp.level_second_approver === userId) {
                                    await env.DB.prepare("UPDATE expense_master SET status = 'Rejected', reject_reason = ?, \"approved_by\" = ?, level_second_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(finalReason, userId, expId).run();
                                    successCount++;
                                } else { failCount++; }
                            } else {
                                failCount++;
                            }
                        } else {
                            // Approval
                            if (currentStatus === "Pending L1" || currentStatus === "Pending") {
                                if (exp.level_first_approver === userId) {
                                    const newStatus = (!isMissing(exp.level_second_approver) && exp.level_second_approver !== 'None') ? "Pending L2" : "Approved";
                                    await env.DB.prepare("UPDATE expense_master SET status = ?, \"approved_by\" = ?, level_first_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(newStatus, userId, expId).run();
                                    successCount++;
                                } else { failCount++; }
                            } else if (currentStatus === "Pending L2") {
                                if (exp.level_second_approver === userId) {
                                    await env.DB.prepare("UPDATE expense_master SET status = 'Approved', \"approved_by\" = ?, level_second_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(userId, expId).run();
                                    successCount++;
                                } else { failCount++; }
                            } else { failCount++; }
                        }
                    }
                } catch (e) { failCount++; }
            }

            return new Response(JSON.stringify({ 
                success: successCount > 0, 
                message: `${successCount} items successfully ${action.toLowerCase()}. ${failCount > 0 ? failCount + ' failed.' : ''}` 
            }), { status: 200, headers });
        }

        /* ================================================================
           POST /api/approval/action
           Single action processing
        ================================================================ */
        if (path === "/api/approval/action" && method === "POST") {
            const body = await request.json();
            const userId = await resolveLoggedInUserId(request, url, body);

            if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });
            
            const { id, type, action, reason } = body; 
            const expId = id || body.exp_id;

            if (!expId || !action) return new Response(JSON.stringify({ success: false, message: "Invalid payload." }), { status: 400, headers });

            if (type === 'Limit') {
                const reqId = expId.replace('REQ-', '');
                const req = await env.DB.prepare("SELECT * FROM limit_approval_requests WHERE id = ? AND manager_id = ?").bind(reqId, userId).first();
                
                if (!req) return new Response(JSON.stringify({ success: false, message: "Access Denied: Only the mapped manager can approve this limit request." }), { status: 403, headers });

                if (req.status.toLowerCase() !== 'pending') {
                    return new Response(JSON.stringify({ success: false, message: "Request already processed." }), { status: 400, headers });
                }

                await env.DB.prepare("UPDATE limit_approval_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(action, reqId).run();

                return new Response(JSON.stringify({ success: true, message: `Limit extension successfully ${action.toLowerCase()}.` }), { status: 200, headers });

            } else {
                const exp = await env.DB.prepare("SELECT * FROM expense_master WHERE exp_id = ?").bind(expId).first();
                if (!exp) return new Response(JSON.stringify({ success: false, message: "Expense not found." }), { status: 404, headers });

                const currentStatus = exp.status || "";

                if (currentStatus === "Approved" || currentStatus === "Rejected") {
                    return new Response(JSON.stringify({ success: false, message: `This expense is already ${currentStatus}.` }), { status: 409, headers });
                }

                if (currentStatus === "Pending L1" || currentStatus === "Pending") {
                    if (exp.level_first_approver !== userId) {
                        return new Response(JSON.stringify({ success: false, message: "Access Denied: You are not the assigned L1 approver." }), { status: 403, headers });
                    }
                    
                    if (action === "Rejected") {
                        if (!reason.trim()) return new Response(JSON.stringify({ success: false, message: "Reason required." }), { status: 400, headers });
                        await env.DB.prepare("UPDATE expense_master SET status = 'Rejected', reject_reason = ?, \"approved_by\" = ?, level_first_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(reason, userId, expId).run();
                        return new Response(JSON.stringify({ success: true, message: "Expense rejected at Level 1." }), { status: 200, headers });
                    } else {
                        const newStatus = (!isMissing(exp.level_second_approver) && exp.level_second_approver !== 'None') ? "Pending L2" : "Approved";
                        await env.DB.prepare("UPDATE expense_master SET status = ?, \"approved_by\" = ?, level_first_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(newStatus, userId, expId).run();
                        return new Response(JSON.stringify({ success: true, message: newStatus === "Approved" ? "Expense fully approved." : "Approved. Now awaiting L2." }), { status: 200, headers });
                    }
                } 
                else if (currentStatus === "Pending L2") {
                    if (exp.level_second_approver !== userId) {
                        return new Response(JSON.stringify({ success: false, message: "Access Denied: You are not the assigned L2 approver." }), { status: 403, headers });
                    }

                    if (action === "Rejected") {
                        if (!reason.trim()) return new Response(JSON.stringify({ success: false, message: "Reason required." }), { status: 400, headers });
                        await env.DB.prepare("UPDATE expense_master SET status = 'Rejected', reject_reason = ?, \"approved_by\" = ?, level_second_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(reason, userId, expId).run();
                        return new Response(JSON.stringify({ success: true, message: "Expense rejected at Level 2." }), { status: 200, headers });
                    } else {
                        await env.DB.prepare("UPDATE expense_master SET status = 'Approved', \"approved_by\" = ?, level_second_approver_time = CURRENT_TIMESTAMP WHERE exp_id = ?").bind(userId, expId).run();
                        return new Response(JSON.stringify({ success: true, message: "Expense fully approved." }), { status: 200, headers });
                    }
                }

                return new Response(JSON.stringify({ success: false, message: "Action not permitted on this expense at current level." }), { status: 403, headers });
            }
        }

        /* ================================================================
           POST /api/approval/edit
           Updated to handle New Itinerary Insertion with correct ID format
        ================================================================ */
        if (path === "/api/approval/edit" && method === "POST") {
            const body = await request.json();
            const userId = body.user_id || await resolveLoggedInUserId(request, url, body);

            if (!userId) return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401, headers });
            
            if (body.type === 'Limit') {
                const reqId = body.exp_id.replace('REQ-', '');
                const { requested_value } = body;
                
                if (!requested_value || isNaN(requested_value)) {
                    return new Response(JSON.stringify({ success: false, message: "Invalid amount." }), { status: 400, headers });
                }

                const limitReq = await env.DB.prepare("SELECT * FROM limit_approval_requests WHERE id = ?").bind(reqId).first();
                if (!limitReq) return new Response(JSON.stringify({ success: false, message: "Limit request not found." }), { status: 404, headers });
                if (limitReq.manager_id !== userId) return new Response(JSON.stringify({ success: false, message: "Access Denied." }), { status: 403, headers });
                
                await env.DB.prepare("UPDATE limit_approval_requests SET requested_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(parseFloat(requested_value), reqId).run();
                    
                return new Response(JSON.stringify({ success: true, message: "Limit amount updated successfully." }), { status: 200, headers });
            }

            const { exp_id, da_amount, hotel_amount, other_expense_amount, total_amount, legs } = body;

            if (!exp_id) return new Response(JSON.stringify({ success: false, message: "Missing exp_id." }), { status: 400, headers });

            const exp = await env.DB.prepare("SELECT * FROM expense_master WHERE exp_id = ?").bind(exp_id).first();
            if (!exp) return new Response(JSON.stringify({ success: false, message: "Expense not found." }), { status: 404, headers });

            let canEdit = false;
            if ((exp.status === 'Pending L1' || exp.status === 'Pending') && exp.level_first_approver === userId) canEdit = true;
            if (exp.status === 'Pending L2' && exp.level_second_approver === userId) canEdit = true;

            if (!canEdit) {
                return new Response(JSON.stringify({ success: false, message: "Access Denied: You cannot edit this expense at its current stage." }), { status: 403, headers });
            }

            const stmts = [];

            stmts.push(env.DB.prepare(`
                UPDATE expense_master
                SET da_amount = ?, hotel_amount = ?, other_expense_amount = ?, total_amount = ?
                WHERE exp_id = ?
            `).bind(
                parseFloat(da_amount    || 0),
                parseFloat(hotel_amount || 0),
                parseFloat(other_expense_amount || 0),
                parseFloat(total_amount || 0),
                exp_id
            ));

            if (legs && legs.length > 0) {
                for (let i = 0; i < legs.length; i++) {
                    const leg = legs[i];
                    const legNumber = i + 1; // Used to maintain correct sequence

                    if (String(leg.id).startsWith("new_")) {
                        // Insert New Leg
                        const newItineraryId = `${exp_id}-${legNumber}`;
                        stmts.push(env.DB.prepare(`
                            INSERT INTO expense_itinerary (
                                itinerary_id, exp_id, leg_number,
                                from_location, to_location, from_district, to_district,
                                travel_mode, distance_km, travel_amount, sub_mode, sub_amount, visit_purpose,
                                calls_assigned, calls_completed, pms_count, asset_tagging
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).bind(
                            newItineraryId, // ID Format updated to exp_id-legNumber (e.g., RJ-06/26-000139-2)
                            exp_id,
                            legNumber,
                            leg.from_location !== undefined ? leg.from_location : null,
                            leg.to_location   !== undefined ? leg.to_location   : null,
                            leg.from_district !== undefined ? leg.from_district : null,
                            leg.to_district   !== undefined ? leg.to_district   : null,
                            leg.travel_mode   !== undefined ? leg.travel_mode   : null,
                            leg.distance_km   !== undefined ? parseFloat(leg.distance_km)   : null,
                            leg.travel_amount !== undefined ? parseFloat(leg.travel_amount) : null,
                            leg.sub_mode      !== undefined ? leg.sub_mode      : null,
                            leg.sub_amount    !== undefined ? parseFloat(leg.sub_amount)    : null,
                            leg.visit_purpose !== undefined ? leg.visit_purpose : null,
                            leg.ws_assigned   !== undefined ? parseInt(leg.ws_assigned, 10) : null,
                            leg.ws_closed     !== undefined ? parseInt(leg.ws_closed,   10) : null,
                            leg.ws_pms        !== undefined ? parseInt(leg.ws_pms,      10) : null,
                            leg.ws_asset      !== undefined ? parseInt(leg.ws_asset,    10) : null
                        ));
                    } else {
                        // Update Existing Leg
                        stmts.push(env.DB.prepare(`
                            UPDATE expense_itinerary
                            SET
                                leg_number      = ?,
                                from_location   = COALESCE(?, from_location),
                                to_location     = COALESCE(?, to_location),
                                from_district   = COALESCE(?, from_district),
                                to_district     = COALESCE(?, to_district),
                                travel_mode     = COALESCE(?, travel_mode),
                                distance_km     = COALESCE(?, distance_km),
                                travel_amount   = COALESCE(?, travel_amount),
                                sub_mode        = COALESCE(?, sub_mode),
                                sub_amount      = COALESCE(?, sub_amount),
                                visit_purpose   = COALESCE(?, visit_purpose),
                                calls_assigned  = COALESCE(?, calls_assigned),
                                calls_completed = COALESCE(?, calls_completed),
                                pms_count       = COALESCE(?, pms_count),
                                asset_tagging   = COALESCE(?, asset_tagging)
                            WHERE itinerary_id = ? AND exp_id = ?
                        `).bind(
                            legNumber, // Update leg number dynamically to keep order
                            leg.from_location  !== undefined ? leg.from_location  : null,
                            leg.to_location    !== undefined ? leg.to_location    : null,
                            leg.from_district  !== undefined ? leg.from_district  : null,
                            leg.to_district    !== undefined ? leg.to_district    : null,
                            leg.travel_mode    !== undefined ? leg.travel_mode    : null,
                            leg.distance_km    !== undefined ? parseFloat(leg.distance_km)   : null,
                            leg.travel_amount  !== undefined ? parseFloat(leg.travel_amount) : null,
                            leg.sub_mode       !== undefined ? leg.sub_mode       : null,
                            leg.sub_amount     !== undefined ? parseFloat(leg.sub_amount)    : null,
                            leg.visit_purpose  !== undefined ? leg.visit_purpose  : null,
                            leg.ws_assigned    !== undefined ? parseInt(leg.ws_assigned, 10) : null,
                            leg.ws_closed      !== undefined ? parseInt(leg.ws_closed,   10) : null,
                            leg.ws_pms         !== undefined ? parseInt(leg.ws_pms,      10) : null,
                            leg.ws_asset       !== undefined ? parseInt(leg.ws_asset,    10) : null,
                            leg.id,
                            exp_id
                        ));
                    }
                }
            }

            await env.DB.batch(stmts);

            return new Response(JSON.stringify({ success: true, message: "Expense amounts and details overwritten successfully." }), { status: 200, headers });
        }

        return new Response(JSON.stringify({ success: false, message: "Route Not Found" }), { status: 404, headers });
    } catch (e) {
        console.error("approvalHandler error:", e.message, e.stack);
        return new Response(JSON.stringify({ success: false, message: "System Error: " + e.message }), { status: 500, headers });
    }
}
