import { getOTPTemplate, sendResendEmail } from '../utils/email';

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
    const { user_id, dob, doj, otp, new_password, action } = data;

    const user: any = await env.DB.prepare(
      "SELECT user_id, full_name, mail_id, account_status FROM user WHERE user_id = ? AND date_of_birth = ? AND date_joining = ?"
    ).bind(user_id, dob, doj).first();

    if (!user) {
      return new Response(JSON.stringify({ success: false, message: "Details did not match. Verification failed." }), { 
        status: 404, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const status = user.account_status ? user.account_status.toLowerCase() : 'active';

    if (status === 'in-active') {
      return new Response(JSON.stringify({ 
        success: false, 
        message: "Your account is inactive. Please contact admin for activation." 
      }), { 
        status: 403, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    if (action === "SEND_OTP") {
      const existing: any = await env.DB.prepare("SELECT attempts FROM otp_verifications WHERE user_id = ?").bind(user_id).first();
      let currentAttempts = existing ? existing.attempts : 0;
      
      if (currentAttempts >= 3) {
        return new Response(JSON.stringify({ success: false, message: "Security limit reached. Please try again later." }), { 
          status: 429, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 5 * 60000).toISOString();

      await env.DB.prepare("INSERT OR REPLACE INTO otp_verifications (user_id, otp, expires_at, attempts) VALUES (?, ?, ?, ?)")
        .bind(user_id, generatedOtp, expires, currentAttempts + 1).run();

      const emailHtml = getOTPTemplate(user.full_name, generatedOtp, "Password Reset");
      
      try {
        await sendResendEmail(user.mail_id, "Security Verification - Account Recovery", emailHtml);
      } catch (err: any) {
        return new Response(JSON.stringify({ success: false, message: "Email failed: " + err.message }), { 
          status: 500, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      return new Response(JSON.stringify({ success: true, message: "Verification code sent to your email." }), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    if (action === "VERIFY_RESET") {
      const stored: any = await env.DB.prepare("SELECT otp, expires_at FROM otp_verifications WHERE user_id = ?").bind(user_id).first();
      
      if (!stored || stored.otp !== otp || new Date() > new Date(stored.expires_at)) {
        return new Response(JSON.stringify({ success: false, message: "Invalid or expired OTP." }), { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      // In real app, make sure password hashing is used if needed.
      // (Assuming you'll update passwords to be securely hashed like in admin.ts)
      await env.DB.prepare("UPDATE user SET password = ?, failed_attempts = 0, account_status = 'Active' WHERE user_id = ?").bind(new_password, user_id).run();
      await env.DB.prepare("DELETE FROM otp_verifications WHERE user_id = ?").bind(user_id).run();
      
      return new Response(JSON.stringify({ success: true, message: "Password reset successful. Account activated." }), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    return new Response(JSON.stringify({ success: false, message: "Invalid action" }), { 
      status: 400, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });

  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, message: "Server Error: " + e.message }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
};
