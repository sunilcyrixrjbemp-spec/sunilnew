export default async function profileHandler(request, env, corsHeaders) {
    if (request.method !== "GET") {
        return new Response(JSON.stringify({ success: false, message: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }

    try {
        const url = new URL(request.url);

        /* ================================================================
           ROUTE 1: FETCH TEAM HIERARCHY (/api/team)
        ================================================================ */
        if (url.pathname.includes('/api/team')) {
            const managerId = url.searchParams.get("manager_id");
            if (!managerId) {
                return new Response(JSON.stringify({ success: false, message: "Manager ID is required" }), { 
                    status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } 
                });
            }

            // SMART ROLE CHECK: Keyword matching, case-insensitive
            const managerUser = await env.DB.prepare("SELECT role FROM user WHERE user_id = ?").bind(managerId).first();
            const rawRole = (managerUser && managerUser.role) ? String(managerUser.role).trim().toUpperCase() : '';
            
            const isAdmin = rawRole === 'ADMIN' || rawRole === 'SUPERADMIN' || rawRole === 'HR';
            const isManager = rawRole.includes('MANAGER') || rawRole.includes('INCHARGE');
            const isCoordinator = rawRole.includes('COORDINATOR');

            let teamQuery = `
                SELECT u.user_id, u.full_name, u.designation, u.role, u.e_code, u.account_status,
                       COALESCE((SELECT full_name FROM user l1 WHERE l1.user_id = u.level_first_approver), 'No Manager Assigned') as manager_name
                FROM user u
                WHERE 1=1
            `;
            let bindings = [];

            if (isAdmin) {
                // Admin gets everyone to display the full grouped organogram
            } else if (isManager && isCoordinator) {
                teamQuery += ` AND (u.level_first_approver = ? OR u.level_second_approver = ?)`;
                bindings.push(managerId, managerId);
            } else if (isManager) {
                teamQuery += ` AND u.level_first_approver = ?`;
                bindings.push(managerId);
            } else if (isCoordinator) {
                teamQuery += ` AND u.level_second_approver = ?`;
                bindings.push(managerId);
            } else {
                // FALLBACK: Regardless of spelling, if they are mapped in the DB, show them their team!
                teamQuery += ` AND (u.level_first_approver = ? OR u.level_second_approver = ?)`;
                bindings.push(managerId, managerId);
            }

            teamQuery += ` ORDER BY manager_name ASC, u.full_name ASC`;

            const { results } = await env.DB.prepare(teamQuery).bind(...bindings).all();

            return new Response(JSON.stringify({ success: true, team: results || [] }), { 
                status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } 
            });
        }

        /* ================================================================
           ROUTE 2: FETCH USER PROFILE (/api/profile)
        ================================================================ */
        // Support for both path parts (/api/profile/123) AND query params (/api/profile?user_id=123)
        const pathParts = url.pathname.split('/');
        const pathUserId = pathParts[pathParts.length - 1];
        const userId = url.searchParams.get("user_id") || (pathUserId !== "profile" && pathUserId !== "team" ? pathUserId : null);

        if (!userId) {
            return new Response(JSON.stringify({ success: false, message: "User ID is required" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Fetching Profile + Converting Approver IDs to Actual Names
        const userProfile = await env.DB.prepare(
            `SELECT 
                u.user_id, u.e_code, u.full_name, u.date_of_birth, u.date_joining, 
                u.designation, u.mobile_number, u.mail_id, u.zone_name, u.district_name, 
                u.account_status, u.grade, u.role, 
                COALESCE((SELECT full_name FROM user l1 WHERE l1.user_id = u.level_first_approver), u.level_first_approver) as level_first_approver, 
                COALESCE((SELECT full_name FROM user l2 WHERE l2.user_id = u.level_second_approver), u.level_second_approver) as level_second_approver 
            FROM user u 
            WHERE u.user_id = ?`
        ).bind(userId).first();

        if (!userProfile) {
            return new Response(JSON.stringify({ success: false, message: "User not found" }), {
                status: 404,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({
            success: true,
            profile: userProfile
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (e) {
        console.error("Profile/Team API Error:", e);
        return new Response(JSON.stringify({ success: false, message: "Internal Server Error" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}
