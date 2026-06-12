async function sendEmail(to, subject, body) {
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": "Bearer re_i7WRWahS_GbcGT7C65PH4fkAvez4DyYiS",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: "Sunil Bishnoi <rjbemp-bikaner@cyrix.in>",
            to: [to],
            subject: subject,
            html: body
        })
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error("Resend failed: " + errText);
    }
}

export default async function unlockHandler(request, env, corsHeaders) {
    const headers = { ...corsHeaders, "Content-Type": "application/json" };
    if (request.method === "OPTIONS") return new Response(null, { headers });

    try {
        const data = await request.json();
        const { user_id, e_code, dob, doj, otp, action } = data;

        const user = await env.DB.prepare(
            "SELECT user_id, full_name, mail_id, account_status FROM user WHERE user_id = ? AND e_code = ? AND date_of_birth = ? AND date_joining = ?"
        ).bind(user_id, e_code, dob, doj).first();

        if (!user) {
            return new Response(JSON.stringify({ success: false, message: "Verification failed. Incorrect details." }), { status: 404, headers });
        }

        const status = user.account_status ? user.account_status.toLowerCase() : 'active';

        if (status === 'in-active') {
            return new Response(JSON.stringify({ 
                success: false, 
                message: "Your account is inactive. Please contact admin for activation." 
            }), { status: 403, headers });
        }

        if (action === "SEND_OTP") {
            const existing = await env.DB.prepare("SELECT attempts FROM otp_verifications WHERE user_id = ?").bind(user_id).first();
            let currentAttempts = existing ? existing.attempts : 0;
            
            if (currentAttempts >= 3) {
                return new Response(JSON.stringify({ success: false, message: "Security limit reached. Try again later." }), { status: 429, headers });
            }

            const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
            const expires = new Date(Date.now() + 5 * 60000).toISOString();
            let senderIdx = (currentAttempts >= 1) ? 1 : 0;

            await env.DB.prepare("INSERT OR REPLACE INTO otp_verifications (user_id, otp, expires_at, attempts) VALUES (?, ?, ?, ?)")
                .bind(user_id, generatedOtp, expires, currentAttempts + 1).run();

            const emailTemplate = `
                <div style="font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 550px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08);">
                    <div style="background-color: #1e3a8a; padding: 25px; text-align: center;"><h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 600;">Cyrix Healthcare</h1></div>
                    <div style="padding: 40px; background-color: #ffffff;">
                        <p style="font-size: 16px; color: #1e293b;">Dear <b>${user.full_name}</b>,</p>
                        <p style="font-size: 15px; color: #475569; line-height: 1.6;">Use the following verification code to <b>Unlock</b> your account access:</p>
                        <div style="text-align: center; margin: 35px 0;">
                            <div style="display: inline-block; background-color: #f8fafc; border: 1px solid #cbd5e1; padding: 18px 35px; border-radius: 10px;">
                                <span style="font-size: 34px; font-weight: 700; color: #2563eb; letter-spacing: 8px;">${generatedOtp}</span>
                            </div>
                            <p style="font-size: 13px; color: #94a3b8; margin-top: 15px;">Valid for 5 minutes only.</p>
                        </div>
                        <p style="font-size: 14px; color: #64748b;">If you did not request this, please contact support.</p>
                        <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 30px 0;">
                        <div style="text-align: center; font-size: 11px; color: #94a3b8;">&copy; 2026 Cyrix Healthcare Pvt. Ltd. | Account Security</div>
                    </div>
                </div>`;
            
            await sendEmail(user.mail_id, "Action Required: Account Unlock Request", emailTemplate, senderIdx);
            return new Response(JSON.stringify({ success: true, message: "Unlock code sent to your email." }), { status: 200, headers });
        }

        if (action === "VERIFY_UNLOCK") {
            const stored = await env.DB.prepare("SELECT otp, expires_at FROM otp_verifications WHERE user_id = ?").bind(user_id).first();
            
            if (!stored || stored.otp !== otp || new Date() > new Date(stored.expires_at)) {
                return new Response(JSON.stringify({ success: false, message: "Invalid or expired OTP." }), { status: 400, headers });
            }

            await env.DB.prepare("UPDATE user SET account_status = 'Active', failed_attempts = 0 WHERE user_id = ?").bind(user_id).run();
            await env.DB.prepare("DELETE FROM otp_verifications WHERE user_id = ?").bind(user_id).run();
            
            return new Response(JSON.stringify({ success: true, message: "Account unlocked successfully." }), { status: 200, headers });
        }
    } catch (e) { 
        return new Response(JSON.stringify({ success: false, message: "Server Error: " + e.message }), { status: 500, headers }); 
    }
}
