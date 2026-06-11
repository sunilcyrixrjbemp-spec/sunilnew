import indexHtml from './index.html';
import adminHtml from './admin.html';
import profileHtml from './profile.html';
import expenseHtml from './expense.html';
import resetHtml from './reset.html';
import retrieveHtml from './retrieve.html';
import homeHtml from './home.html';
import approvalHtml from './approval.html';
import dashboardHtml from './dashboard.html';
import uploadHtml from './upload.html';
import monthHtml from './month.html';

import styleCss from './style.css';
import adminCss from './admin.css';
import profileCss from './profile.css';
import expenseCss from './expense.css';
import resetCss from './reset.css';
import retrieveCss from './retrieve.css';
import homeCss from './home.css';
import approvalCss from './style.css';
import dashboardCss from './style.css';
import uploadCss from './style.css';
import monthCss from './style.css';

import logoData from './logo.png';

import loginHandler from './login.js';
import adminHandler from './admin.js';
import profileHandler from './profile.js';
import retriveHandler from './retrive.js'; 
import unlockHandler from './unlock.js';
import forgotHandler from './forgot.js';
import expenseHandler from './expense.js'; 
import approvalHandler from './approval.js';
import dashboardHandler from './dashboard_api.js'; 
import uploadHandler from './upload_handler.js';
import homeHandler from './home.js';
import monthHandler from './month.js'; // ✅ NEW: Month Summary handler

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const pages = {
    "/": { html: indexHtml, css: styleCss },
    "/index.html": { html: indexHtml, css: styleCss },
    "/home": { html: homeHtml, css: homeCss },
    "/home.html": { html: homeHtml, css: homeCss },
    "/admin": { html: adminHtml, css: adminCss },
    "/admin.html": { html: adminHtml, css: adminCss },
    "/profile": { html: profileHtml, css: profileCss },
    "/profile.html": { html: profileHtml, css: profileCss },
    "/expense": { html: expenseHtml, css: expenseCss },
    "/expense.html": { html: expenseHtml, css: expenseCss },
    "/reset": { html: resetHtml, css: resetCss },
    "/reset.html": { html: resetHtml, css: resetCss },
    "/retrieve": { html: retrieveHtml, css: retrieveCss },
    "/retrieve.html": { html: retrieveHtml, css: retrieveCss },
    "/approval": { html: approvalHtml, css: approvalCss },
    "/approval.html": { html: approvalHtml, css: approvalCss },
    "/month": { html: monthHtml, css: monthCss },       // ✅ NEW
    "/month.html": { html: monthHtml, css: monthCss },  // ✅ NEW (already था, confirm)

    // NEW MAP: Report routes load the Dashboard HTML perfectly
    "/report": { html: dashboardHtml, css: dashboardCss },
    "/report.html": { html: dashboardHtml, css: dashboardCss },
    
    // Original Dashboard Routes (kept as fallback)
    "/dashboard": { html: dashboardHtml, css: dashboardCss },
    "/dashboard.html": { html: dashboardHtml, css: dashboardCss },
    
    "/upload": { html: uploadHtml, css: styleCss },
    "/upload.html": { html: uploadHtml, css: styleCss }
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        if (pages[path]) {
            let { html, css } = pages[path];
            
            // Generate Base64 for the logo
            const logoBase64 = `data:image/png;base64,${b64encode(logoData)}`;
            
            // Inject CSS and replace Logo Source
            let finalHtml = html.replace('</head>', `<style>${css}</style></head>`);
            finalHtml = finalHtml.replace(/src="logo.png"/g, `src="${logoBase64}"`);
            
            return new Response(finalHtml, { 
                headers: { "Content-Type": "text/html", ...corsHeaders } 
            });
        }

        // API Routes
        if (path.startsWith("/api/login"))    return loginHandler(request, env, corsHeaders);
        if (path.startsWith("/api/admin"))    return adminHandler(request, env, corsHeaders);
        if (path.startsWith("/api/profile"))  return profileHandler(request, env, corsHeaders);
        if (path.startsWith("/api/retrive"))  return retriveHandler(request, env, corsHeaders);
        if (path.startsWith("/api/unlock"))   return unlockHandler(request, env, corsHeaders);
        if (path.startsWith("/api/forgot"))   return forgotHandler(request, env, corsHeaders);
        if (path.startsWith("/api/expense"))  return expenseHandler(request, env, corsHeaders);
        if (path.startsWith("/api/approval")) return approvalHandler(request, env, corsHeaders);
        if (path.startsWith("/api/home"))     return homeHandler(request, env, corsHeaders);
        if (path.startsWith("/api/month"))    return monthHandler(request, env, corsHeaders); // ✅ NEW

        // --- Map both /api/report & /api/dashboard to dashboardHandler ---
        if (path.startsWith("/api/report") || path.startsWith("/api/dashboard")) {
            return dashboardHandler(request, env, corsHeaders);
        }
        
        if (path.startsWith("/api/upload")) return uploadHandler(request, env, corsHeaders);

        return new Response("Page Not Found", { status: 404, headers: corsHeaders });
    }
};

function b64encode(buf) {
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
