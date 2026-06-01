export default async function handler(req, res) {
  // Support standard CORS headers to allow cross-origin requests securely
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-client-id, x-client-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: "METHOD_NOT_ALLOWED",
      message: "Only POST requests are allowed on this endpoint."
    });
  }

  try {
    const { order_amount, order_id, customer_details, order_meta, order_currency } = req.body || {};

    const CASHFREE_APP_ID = (process.env.CASHFREE_APP_ID || "").replace(/^["']|["']$/g, "").trim();
    const CASHFREE_SECRET_KEY = (process.env.CASHFREE_SECRET_KEY || "").replace(/^["']|["']$/g, "").trim();
    
    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      console.error("[CASHFREE] Missing CASHFREE_APP_ID or CASHFREE_SECRET_KEY in server environment.");
      return res.status(400).json({
        error: "CONFIGURATION_ERROR",
        message: "Cashfree gateway is not configured properly on the server side. Please ensure CASHFREE_APP_ID and CASHFREE_SECRET_KEY are set."
      });
    }

    const env = (process.env.CASHFREE_ENV || "sandbox").toLowerCase().trim();
    const isProd = env === "production" || env === "live";
    const gatewayUrl = isProd
      ? "https://api.cashfree.com/pg/orders"
      : "https://sandbox.cashfree.com/pg/orders";

    // customer details sanitization
    const details = customer_details || {};
    let cleanPhone = String(details.customer_phone || "9999999999").replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      cleanPhone = cleanPhone.padEnd(10, "9");
    } else if (cleanPhone.length > 15) {
      cleanPhone = cleanPhone.slice(-10);
    }

    let cleanCustID = String(details.customer_id || `CUST_${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
    if (cleanCustID.length > 50) {
      cleanCustID = cleanCustID.slice(0, 50);
    }

    let cleanOrderID = String(order_id || `ORD_CF_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (cleanOrderID.length > 45) {
      cleanOrderID = cleanOrderID.slice(0, 45);
    }

    // Build return URL
    const returnUrl = (order_meta && order_meta.return_url) || `${process.env.APP_URL || "http://localhost:3000"}/user.html?cf_order_id={order_id}`;

    const payload = {
      order_amount: Number(order_amount),
      order_currency: order_currency || "INR",
      order_id: cleanOrderID,
      customer_details: {
        customer_id: cleanCustID,
        customer_phone: cleanPhone,
        customer_name: details.customer_name ? String(details.customer_name).slice(0, 100) : "Valued Customer",
        customer_email: details.customer_email ? String(details.customer_email).slice(0, 100) : "customer@example.com"
      },
      order_meta: {
        return_url: returnUrl
      }
    };

    console.log(`[CASHFREE] Creating order via Vercel serverless function. Order ID: ${payload.order_id}, Url: ${gatewayUrl}`);

    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET_KEY,
        "x-api-version": "2023-08-01"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("[CASHFREE] Failed to parse Cashfree response text as JSON:", responseText);
      return res.status(502).json({
        error: "BAD_GATEWAY",
        message: "Received invalid non-JSON response from Cashfree gateway API.",
        raw: responseText.slice(0, 250)
      });
    }

    if (!response.ok) {
      console.error("[CASHFREE] Error response from Cashfree Gateway:", responseData);
      return res.status(response.status).json({
        error: "GATEWAY_ERROR",
        message: responseData.message || "Failed to create order on Cashfree server.",
        details: responseData
      });
    }

    return res.status(200).json(responseData);

  } catch (error) {
    console.error("[CASHFREE] Internal server error exception:", error);
    return res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      message: error.message || "An unexpected connection exception occurred during order creation with Cashfree server."
    });
  }
}
