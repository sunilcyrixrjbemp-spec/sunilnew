interface Env {
  DB: D1Database;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ success: false, message: "Method not allowed" }), { 
      status: 405, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  try {
    const data: any = await request.json();
    const { user_id, password } = data;

    if (!user_id || !password) {
      return new Response(JSON.stringify({ success: false, message: "User ID and Password are required." }), { 
        status: 400, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const user: any = await env.DB.prepare(
      "SELECT user_id, password, password_salt, full_name, account_status, failed_attempts, role FROM user WHERE user_id = ?"
    ).bind(user_id).first();

    if (!user) {
      return new Response(JSON.stringify({ success: false, message: "Invalid User ID." }), { 
        status: 401, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const status = user.account_status ? user.account_status.toLowerCase() : 'active';

    if (status === 'locked') {
      return new Response(JSON.stringify({ 
        success: false, 
        message: "Your account is locked. Please visit 'Account Help' to unlock it." 
      }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (status === 'in-active') {
      return new Response(JSON.stringify({ 
        success: false, 
        message: "Your account is inactive. Please contact admin for activation." 
      }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Check if password matches plaintext directly (legacy fallback) or hashed PBKDF2
    let isPasswordValid = (password === user.password);

    if (!isPasswordValid && user.password_salt) {
      try {
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
            salt: encoder.encode(user.password_salt),
            iterations: 100000,
            hash: 'SHA-256'
          },
          passwordKey,
          256
        );

        const hashedInput = btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
        isPasswordValid = (hashedInput === user.password);
      } catch (hashErr) {
        isPasswordValid = false;
      }
    }

    if (!isPasswordValid) {
      const currentAttempts = parseInt(user.failed_attempts || 0, 10);
      const attempts = currentAttempts + 1;

      if (attempts >= 5) {
        await env.DB.prepare("UPDATE user SET account_status = 'Locked', failed_attempts = ? WHERE user_id = ?")
          .bind(attempts, user_id).run();
        return new Response(JSON.stringify({ 
          success: false, 
          message: "Too many attempts. Your account is now locked. Please visit 'Account Help' to unlock it." 
        }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } else {
        await env.DB.prepare("UPDATE user SET failed_attempts = ? WHERE user_id = ?")
          .bind(attempts, user_id).run();
        return new Response(JSON.stringify({ success: false, message: `Incorrect password. ${5 - attempts} attempts left.` }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // Reset failed attempts on success
    await env.DB.prepare("UPDATE user SET failed_attempts = 0 WHERE user_id = ?").bind(user_id).run();

    return new Response(JSON.stringify({
      success: true,
      message: "Login successful!",
      user_id: user.user_id,
      full_name: user.full_name,
      role: user.role
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, message: "Server Error: " + e.message }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
};
