async function fetchSheetData() {
    const SHEET_ID = "10jVaKBLKOrXvmVMU5cnHIIAkYU_9APZt9FGr9N5Pz7M";
    const GID = "1892818277";
    const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
    
    try {
        const response = await fetch(CSV_URL);
        const text = await response.text();
        
        const rows = text.split('\n').filter(row => row.trim() !== '').map(row => {
            const re = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
            return row.split(re).map(cell => cell.replace(/^"|"$/g, '').trim());
        });

        if (rows.length === 0) return [];

        const headers = rows[0];
        const data = rows.slice(1).map(row => {
            let obj = {};
            headers.forEach((header, i) => {
                obj[header.trim()] = row[i] || "";
            });
            return obj;
        });
        
        return data;
    } catch (error) {
        return [];
    }
}

export default async function assetMasterHandler(request, env, corsHeaders) {
    const headers = { 
        ...corsHeaders, 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60" 
    };
    const url = new URL(request.url);

    try {
        const assets = await fetchSheetData();

        const qrSearch = url.searchParams.get('qr');
        const serialSearch = url.searchParams.get('serial');
        const districtSearch = url.searchParams.get('district');

        if (qrSearch) {
            const asset = assets.find(a => a["QR Code"] == qrSearch);
            return new Response(JSON.stringify({ success: !!asset, data: asset }), { headers });
        }

        if (serialSearch) {
            const asset = assets.find(a => a["Serial No."] == serialSearch);
            return new Response(JSON.stringify({ success: !!asset, data: asset }), { headers });
        }
        
        if (districtSearch) {
            const filtered = assets.filter(a => a["District Name"] == districtSearch);
            return new Response(JSON.stringify({ success: true, count: filtered.length, data: filtered }), { headers });
        }

        return new Response(JSON.stringify({
            success: true,
            total_assets: assets.length,
            asset_master_data: assets
        }), { status: 200, headers });

    } catch (e) {
        return new Response(JSON.stringify({ 
            success: false, 
            message: "Direct API Error: " + e.message 
        }), { status: 500, headers });
    }
}
