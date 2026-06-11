// ============================================================
//  DASHBOARD HANDLER — Secured Hashing Version
//  Cloudflare Workers + D1 (SQLite) Compatible
// ============================================================

function isMissing(v) {
    return v === null || v === undefined || ['', 'null', 'undefined'].includes(String(v).trim().toLowerCase());
}

// SECURE HASHING UTILITY (PBKDF2) - Industry Standard
async function hashPassword(password, salt) {
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
        'raw', 
        encoder.encode(password), 
        { name: 'PBKDF2' }, 
        false, 
        ['deriveBits']
    );
    
    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: encoder.encode(salt),
            iterations: 100000,
            hash: 'SHA-256'
        },
        passwordKey,
        256
    );

    return btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
}

function generateSalt() {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

async function sendEmail(to, subject, body) {
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": "Bearer re_i7WRWahS_GbcGT7C65PH4fkAvez4DyYiS",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: "Cyrix Healthcare <noreply@sunilbishnoi.co.in>",
            to: [to],
            subject: subject,
            html: body
        })
    });
    if (!res.ok) {
        const errText = await res.text();
        console.error("Resend email error:", errText);
    }
}

async function getNextId(env) {
    const result = await env.DB.prepare("SELECT user_id FROM user WHERE user_id LIKE 'RJ%' ORDER BY user_id DESC LIMIT 1").first();
    if (!result || !result.user_id) return "RJ001";
    const match = result.user_id.match(/RJ(\d+)/);
    return match ? `RJ${(parseInt(match[1], 10) + 1).toString().padStart(3, '0')}` : "RJ001";
}

export default async function adminHandler(request, env, corsHeaders) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {
        // Dropdown data retrieval
        if (path === "/api/admin/dropdowns") {
            const zones = await env.DB.prepare('SELECT DISTINCT zone_name FROM "Facily Details"').all();
            const roles = await env.DB.prepare('SELECT DISTINCT Role FROM Role').all();
            const grades = await env.DB.prepare('SELECT DISTINCT grade FROM allowance_master').all();
            const nextId = await getNextId(env);
            return new Response(JSON.stringify({ 
                success: true, 
                zones: zones.results.map(z => z.zone_name), 
                roles: roles.results.map(r => r.Role), 
                grades: grades.results.map(g => g.grade), 
                next_id: nextId 
            }), { headers });
        }

        // District retrieval based on zone
        if (path === "/api/admin/districts") {
            const zone = url.searchParams.get('zone');
            const districts = await env.DB.prepare('SELECT DISTINCT district_name FROM "Facily Details" WHERE zone_name = ?').bind(zone).all();
            return new Response(JSON.stringify({ success: true, districts: districts.results.map(d => d.district_name) }), { headers });
        }

        if (path === "/api/admin/users") {
            if (method === "GET") {
                // SECURITY: Never select 'password' or 'password_salt' columns to prevent data leakage
                const { results } = await env.DB.prepare(`
                    SELECT user_id, e_code, full_name, designation, mobile_number, mail_id, 
                    e_upkaran_id, date_of_birth, date_joining, zone_name, district_name, 
                    grade, role, level_first_approver, level_second_approver, account_status, failed_attempts 
                    FROM user ORDER BY user_id DESC
                `).all();
                return new Response(JSON.stringify({ success: true, users: results }), { headers });
            }
            
            if (method === "POST") {
                const d = await request.json();
                const nextId = await getNextId(env);
                
                // Password Hashing Logic
                const salt = generateSalt();
                const plainPassword = d.password || '123456';
                const hashedPassword = await hashPassword(plainPassword, salt);

                await env.DB.prepare(`
                    INSERT INTO user (
                        user_id, e_code, full_name, designation, mobile_number, mail_id, 
                        e_upkaran_id, date_of_birth, date_joining, zone_name, district_name, 
                        grade, role, level_first_approver, level_second_approver, 
                        password, password_salt, account_status, failed_attempts
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 0)
                `)
                .bind(
                    nextId, d.e_code, d.full_name, d.designation, d.mobile_number, d.mail_id, 
                    d.e_upkaran_id || null, d.date_of_birth, d.date_joining, d.zone_name, d.district_name, 
                    d.grade, d.role, d.level_first_approver || null, d.level_second_approver || null, 
                    hashedPassword, salt
                ).run();

                // Send Welcome Email to the new user
                if (d.mail_id) {
                    const welcomeEmail = `
                    <div style="font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 550px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08);">
                        <div style="background-color: #1e3a8a; padding: 25px; text-align: center;">
                            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 600;">Cyrix Healthcare</h1>
                        </div>
                        <div style="padding: 40px; background-color: #ffffff;">
                            <p style="font-size: 16px; color: #1e293b;">Dear <b>${d.full_name}</b>,</p>
                            <p style="font-size: 15px; color: #475569; line-height: 1.6;">Welcome to <b>Cyrix Healthcare</b>! Your account has been created successfully. Below are your login credentials:</p>
                            <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 24px; margin: 25px 0;">
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr><td style="padding: 8px 0; font-size: 14px; color: #64748b; font-weight: 600;">User ID</td><td style="padding: 8px 0; font-size: 15px; color: #1e293b; font-weight: 700;">${nextId}</td></tr>
                                    <tr><td style="padding: 8px 0; font-size: 14px; color: #64748b; font-weight: 600;">Password</td><td style="padding: 8px 0; font-size: 15px; color: #1e293b; font-weight: 700;">${plainPassword}</td></tr>
                                    <tr><td style="padding: 8px 0; font-size: 14px; color: #64748b; font-weight: 600;">Role</td><td style="padding: 8px 0; font-size: 15px; color: #1e293b; font-weight: 700;">${d.role}</td></tr>
                                    <tr><td style="padding: 8px 0; font-size: 14px; color: #64748b; font-weight: 600;">Zone</td><td style="padding: 8px 0; font-size: 15px; color: #1e293b; font-weight: 700;">${d.zone_name}</td></tr>
                                </table>
                            </div>
                            <p style="font-size: 14px; color: #ef4444; font-weight: 600;">⚠️ Please change your password after first login for security.</p>
                            <p style="font-size: 14px; color: #64748b; margin-top: 15px;">If you have any questions, please contact your administrator.</p>
                            <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 30px 0;">
                            <div style="text-align: center; font-size: 11px; color: #94a3b8;">&copy; 2026 Cyrix Healthcare Pvt. Ltd. | Secure Access</div>
                        </div>
                    </div>`;
                    
                    // Fire-and-forget: don't block user creation on email delivery
                    sendEmail(d.mail_id, "Welcome to Cyrix Healthcare — Your Account Details", welcomeEmail).catch(() => {});
                }
                
                return new Response(JSON.stringify({ success: true }), { headers });
            }
        }

        if (path.startsWith("/api/admin/users/") && !path.endsWith("/status")) {
            const userId = decodeURIComponent(path.split('/').pop());
            if (method === "PUT") {
                const d = await request.json();
                
                let query = `
                    UPDATE user SET e_code=?, full_name=?, designation=?, mobile_number=?, mail_id=?, 
                    e_upkaran_id=?, date_of_birth=?, date_joining=?, zone_name=?, district_name=?, 
                    grade=?, role=?, level_first_approver=?, level_second_approver=?`;
                
                let params = [
                    d.e_code, d.full_name, d.designation, d.mobile_number, d.mail_id, 
                    d.e_upkaran_id || null, d.date_of_birth, d.date_joining, d.zone_name, d.district_name, 
                    d.grade, d.role, d.level_first_approver || null, d.level_second_approver || null
                ];

                // Update password ONLY if provided and not empty
                if (d.password && d.password.trim() !== "") {
                    const newSalt = generateSalt();
                    const newHash = await hashPassword(d.password, newSalt);
                    query += `, password=?, password_salt=?`;
                    params.push(newHash, newSalt);
                }

                query += ` WHERE user_id=?`;
                params.push(userId);

                await env.DB.prepare(query).bind(...params).run();
                return new Response(JSON.stringify({ success: true }), { headers });
            }
            
            if (method === "DELETE") {
                await env.DB.prepare("DELETE FROM user WHERE user_id = ?").bind(userId).run();
                return new Response(JSON.stringify({ success: true }), { headers });
            }
        }

        if (path.includes("/status") && method === "PUT") {
            const parts = path.split('/');
            const userId = decodeURIComponent(parts[parts.length - 2]); 
            const { status } = await request.json();
            
            if (status === 'Active') {
                await env.DB.prepare("UPDATE user SET account_status = ?, failed_attempts = 0 WHERE user_id = ?").bind(status, userId).run();
            } else {
                await env.DB.prepare("UPDATE user SET account_status = ? WHERE user_id = ?").bind(status, userId).run();
            }
            return new Response(JSON.stringify({ success: true }), { headers });
        }

        return new Response(JSON.stringify({ success: false, message: "Route not found" }), { status: 404, headers });
    } catch (e) { 
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers }); 
    }
}
