import { getUserCreatedTemplate, sendResendEmail } from '../utils/email';

interface Env {
  DB: D1Database;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// PBKDF2 secure password hashing utility for backwards compatibility
async function hashPassword(password: string, salt: string) {
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

async function getNextId(env: Env) {
  const result: any = await env.DB.prepare("SELECT user_id FROM user WHERE user_id LIKE 'RJ%' ORDER BY user_id DESC LIMIT 1").first();
  if (!result || !result.user_id) return "RJ001";
  const match = result.user_id.match(/RJ(\d+)/);
  return match ? `RJ${(parseInt(match[1], 10) + 1).toString().padStart(3, '0')}` : "RJ001";
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
    // Dropdown data retrieval
    if (path === "/api/admin/dropdowns") {
      const zones: any = await env.DB.prepare('SELECT DISTINCT zone_name FROM "Facily Details"').all();
      const roles: any = await env.DB.prepare('SELECT DISTINCT Role FROM Role').all();
      const grades: any = await env.DB.prepare('SELECT DISTINCT grade FROM allowance_master').all();
      const nextId = await getNextId(env);
      return new Response(JSON.stringify({ 
        success: true, 
        zones: zones.results.map((z: any) => z.zone_name), 
        roles: roles.results.map((r: any) => r.Role), 
        grades: grades.results.map((g: any) => g.grade), 
        next_id: nextId 
      }), { headers });
    }

    // District retrieval based on zone
    if (path === "/api/admin/districts") {
      const zone = url.searchParams.get('zone');
      const districts: any = await env.DB.prepare('SELECT DISTINCT district_name FROM "Facily Details" WHERE zone_name = ?').bind(zone).all();
      return new Response(JSON.stringify({ success: true, districts: districts.results.map((d: any) => d.district_name) }), { headers });
    }

    if (path === "/api/admin/users") {
      if (method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT user_id, e_code, full_name, designation, mobile_number, mail_id, 
          e_upkaran_id, date_of_birth, date_joining, zone_name, district_name, 
          grade, role, level_first_approver, level_second_approver, account_status, failed_attempts 
          FROM user ORDER BY user_id DESC
        `).all();
        return new Response(JSON.stringify({ success: true, users: results }), { headers });
      }
      
      if (method === "POST") {
        const d: any = await request.json();
        const nextId = await getNextId(env);
        
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

        // Send Welcome Email using Resend
        if (d.mail_id) {
          const emailHtml = getUserCreatedTemplate(d.full_name, nextId, plainPassword, d.role);
          try {
            await sendResendEmail(d.mail_id, "Welcome to Cyrix Healthcare - Account Created", emailHtml);
          } catch (emailErr) {
            console.error("Welcome email failed to send: ", emailErr);
            // Don't fail the API request if only email failed, but we log it
          }
        }
        
        return new Response(JSON.stringify({ success: true }), { headers });
      }
    }

    if (path.startsWith("/api/admin/users/") && !path.endsWith("/status")) {
      const userId = decodeURIComponent(path.split('/').pop() || '');
      if (method === "PUT") {
        const d: any = await request.json();
        
        let query = `
          UPDATE user SET e_code=?, full_name=?, designation=?, mobile_number=?, mail_id=?, 
          e_upkaran_id=?, date_of_birth=?, date_joining=?, zone_name=?, district_name=?, 
          grade=?, role=?, level_first_approver=?, level_second_approver=?`;
        
        let params: any[] = [
          d.e_code, d.full_name, d.designation, d.mobile_number, d.mail_id, 
          d.e_upkaran_id || null, d.date_of_birth, d.date_joining, d.zone_name, d.district_name, 
          d.grade, d.role, d.level_first_approver || null, d.level_second_approver || null
        ];

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
      const { status } = await request.json() as any;
      
      if (status === 'Active') {
        await env.DB.prepare("UPDATE user SET account_status = ?, failed_attempts = 0 WHERE user_id = ?").bind(status, userId).run();
      } else {
        await env.DB.prepare("UPDATE user SET account_status = ? WHERE user_id = ?").bind(status, userId).run();
      }
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ success: false, message: "Route not found" }), { status: 404, headers });
  } catch (e: any) { 
    return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers }); 
  }
};
