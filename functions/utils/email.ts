const RESEND_API_KEY = 're_i7WRWahS_GbcGT7C65PH4fkAvez4DyYiS';
const FROM_EMAIL = 'Cyrix Healthcare <noreply@sunilbishnoi.co.in>';

export async function sendResendEmail(to: string, subject: string, html: string) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html
    })
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Resend email failed: ${err}`);
  }
  return response.json();
}

export function getBaseTemplate(title: string, contentHtml: string): string {
  return `
    <div style="font-family: 'Outfit', 'Segoe UI', Arial, sans-serif; background-color: #0f172a; padding: 40px 20px; color: #f8fafc; min-height: 100vh;">
      <div style="max-width: 550px; margin: 0 auto; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 24px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.3); backdrop-filter: blur(16px);">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #2563eb, #8b5cf6); padding: 35px 20px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.1);">
          <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px;">Cyrix Healthcare</h1>
          <p style="color: rgba(255, 255, 255, 0.8); margin: 5px 0 0 0; font-size: 14px; font-weight: 500;">${title}</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px; background-color: #1e293b;">
          ${contentHtml}
        </div>
        
        <!-- Footer -->
        <div style="background-color: #0f172a; padding: 25px; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.1); font-size: 12px; color: #94a3b8;">
          <p style="margin: 0 0 10px 0;">&copy; 2026 Cyrix Healthcare Pvt. Ltd. | Secure System</p>
          <p style="margin: 0; font-size: 11px; color: #64748b;">This is an automated system email. Please do not reply directly.</p>
        </div>
      </div>
    </div>
  `;
}

export function getOTPTemplate(fullName: string, otp: string, purpose: string): string {
  const content = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #f8fafc;">Dear <b>${fullName}</b>,</p>
    <p style="font-size: 15px; line-height: 1.6; color: #94a3b8;">To complete your <b>${purpose}</b> request, please use the following secure verification code:</p>
    
    <div style="text-align: center; margin: 35px 0;">
      <div style="display: inline-block; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.15); padding: 20px 40px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
        <span style="font-size: 36px; font-weight: 800; color: #3b82f6; letter-spacing: 10px; font-family: monospace;">${otp}</span>
      </div>
      <p style="font-size: 13px; color: #64748b; margin-top: 15px; font-weight: 500;">Valid for 5 minutes only. Do not share this code.</p>
    </div>
    
    <p style="font-size: 14px; line-height: 1.6; color: #64748b; margin-bottom: 0;">If you did not initiate this request, please contact the administrator immediately to secure your account.</p>
  `;
  return getBaseTemplate(purpose, content);
}

export function getUserCreatedTemplate(fullName: string, userId: string, plainPassword: string, role: string): string {
  const content = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #f8fafc;">Dear <b>${fullName}</b>,</p>
    <p style="font-size: 15px; line-height: 1.6; color: #94a3b8;">Welcome to Cyrix Healthcare. Your enterprise account has been successfully created. Here are your secure login credentials:</p>
    
    <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 24px; margin: 30px 0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 15px; color: #f8fafc;">
        <tr>
          <td style="padding: 8px 0; color: #94a3b8; width: 40%; font-weight: 500;">User ID:</td>
          <td style="padding: 8px 0; font-weight: 700; color: #3b82f6;">${userId}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Password:</td>
          <td style="padding: 8px 0; font-weight: 700; font-family: monospace;">${plainPassword}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Assigned Role:</td>
          <td style="padding: 8px 0; font-weight: 600;">${role}</td>
        </tr>
      </table>
    </div>
    
    <p style="font-size: 14px; line-height: 1.6; color: #f8fafc; font-weight: 600; text-align: center; margin: 25px 0;">
      <a href="https://sunilbishnoi.co.in" style="display: inline-block; background: linear-gradient(135deg, #2563eb, #3b82f6); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 12px; font-weight: 700; box-shadow: 0 4px 6px rgba(37,99,235,0.2);">Login to Dashboard</a>
    </p>
    
    <p style="font-size: 13px; line-height: 1.6; color: #64748b; margin-bottom: 0;"><b>Security Notice:</b> Please change your password immediately upon your first successful login.</p>
  `;
  return getBaseTemplate("Account Created", content);
}
