import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for body-parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Enable CORS Cross-Origin Resource Sharing for custom domain frontend integrations
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-version, x-client-id, x-client-secret");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Cashfree Credentials (with robust trim & quotes cleanup, and environment mode unification)
  const CASHFREE_APP_ID = (process.env.CASHFREE_APP_ID || "").replace(/^["']|["']$/g, "").trim();
  const CASHFREE_SECRET_KEY = (process.env.CASHFREE_SECRET_KEY || "").replace(/^["']|["']$/g, "").trim();
  const rawEnv = (process.env.CASHFREE_ENV || "sandbox").toLowerCase().trim();
  const CASHFREE_ENV = (rawEnv === "production" || rawEnv === "live") ? "production" : "sandbox";

  // API 1: Fetch Cashfree Environment settings (public mode only, NOT secrets)
  app.get("/api/cashfree/config", (req, res) => {
    res.json({
      environment: CASHFREE_ENV,
      hasKeys: Boolean(CASHFREE_APP_ID && CASHFREE_SECRET_KEY)
    });
  });

  // API 2: Create a secure Cashfree Order Session
  app.post("/api/cashfree/create-session", async (req, res) => {
    const { order_amount, order_id, customer_details } = req.body;

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      console.warn("Cashfree App ID or Secret Key is not configured.");
      return res.status(400).json({
        error: "COMMUNICATION_ERROR",
        message: "Cashfree credentials are not configured on the live server. Please update CASHFREE_APP_ID and CASHFREE_SECRET_KEY in Environment/Secrets settings."
      });
    }

    const isProd = CASHFREE_ENV === "production";
    const gatewayUrl = isProd
      ? "https://api.cashfree.com/pg/orders"
      : "https://sandbox.cashfree.com/pg/orders";

    try {
      const details = customer_details || {};

      // Robust Phone Sanitization: Strip all non-digits, ensure length is between 10 and 15 digits
      let cleanPhone = String(details.customer_phone || "9999999999").replace(/\D/g, "");
      if (cleanPhone.length < 10) {
        cleanPhone = cleanPhone.padEnd(10, "9");
      } else if (cleanPhone.length > 15) {
        cleanPhone = cleanPhone.slice(-10); // Standard backup: Last 10 digits
      }

      // Robust Customer ID Validation: Alphanumeric and standard separators only, max 50 chars
      let cleanCustID = String(details.customer_id || `CUST_${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
      if (cleanCustID.length > 50) {
        cleanCustID = cleanCustID.slice(0, 50);
      }

      // Robust Order ID Sanitization: Alphanumeric and [_-] only, max 45 chars
      let cleanOrderID = String(order_id || `ORD_CF_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
      if (cleanOrderID.length > 45) {
        cleanOrderID = cleanOrderID.slice(0, 45);
      }

      const payload = {
        order_amount: Number(order_amount),
        order_currency: "INR",
        order_id: cleanOrderID,
        customer_details: {
          customer_id: cleanCustID,
          customer_phone: cleanPhone,
          customer_name: details.customer_name ? String(details.customer_name).slice(0, 100) : "Valued Customer",
          customer_email: details.customer_email ? String(details.customer_email).slice(0, 100) : "customer@example.com"
        },
        order_meta: {
          // Cashfree client fallback redirect URL
          return_url: `${process.env.APP_URL || "http://localhost:3000"}/user.html?cf_order_id={order_id}`
        }
      };

      console.log(`[CASHFREE] Creating order via URL: ${gatewayUrl}, Order ID: ${payload.order_id}`);

      const response = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "x-api-version": "2023-08-01",
          "x-client-id": CASHFREE_APP_ID,
          "x-client-secret": CASHFREE_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const responseData: any = await response.json();

      if (!response.ok) {
        console.error("[CASHFREE] Error Response:", responseData);
        return res.status(response.status).json({
          error: "GATEWAY_ERROR",
          message: responseData.message || "Failed to create order session on Cashfree system API.",
          details: responseData
        });
      }

      if (!responseData || !responseData.payment_session_id) {
        console.error("[CASHFREE] Missing payment_session_id in responseData:", responseData);
        return res.status(500).json({
          error: "GATEWAY_ERROR",
          message: "Cashfree API response did not contain a payment_session_id. Please verify sandbox/production credential alignment.",
          details: responseData
        });
      }

      console.log(`[CASHFREE] Order session created successfully: ${responseData.payment_session_id}`);
      res.json(responseData);

    } catch (error: any) {
      console.error("[CASHFREE] Order creation request exception:", error);
      res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: error.message || "Connection exception raised during order creation with Cashfree server."
      });
    }
  });

  // API 2.5: Secure Cashfree Create-Order Endpoint matching Vercel schema
  const handleVercelCreateOrder = async (req: express.Request, res: express.Response) => {
    // Force response header to always be application/json
    res.setHeader("Content-Type", "application/json");

    const { order_amount, order_id, customer_details, order_meta, order_currency } = req.body || {};

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      console.error("[CASHFREE] Missing CASHFREE_APP_ID or CASHFREE_SECRET_KEY in server environment.");
      return res.status(400).json({
        error: "CONFIGURATION_ERROR",
        message: "Cashfree gateway is not configured properly on the server side. Please ensure CASHFREE_APP_ID and CASHFREE_SECRET_KEY are set."
      });
    }

    const isProd = CASHFREE_ENV === "production";
    const gatewayUrl = isProd
      ? "https://api.cashfree.com/pg/orders"
      : "https://sandbox.cashfree.com/pg/orders";

    try {
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

      console.log(`[CASHFREE] Creating order via express match-up. Order ID: ${payload.order_id}, Url: ${gatewayUrl}`);

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
      let responseData: any;
      try {
        responseData = JSON.parse(responseText);
      } catch (parseErr) {
        console.error("[CASHFREE] Failed to parse response text as JSON:", responseText);
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

      res.status(200).json(responseData);

    } catch (error: any) {
      console.error("[CASHFREE] Internal server error exception:", error);
      res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: error.message || "An unexpected connection exception occurred during order creation."
      });
    }
  };

  app.post("/api/create-order", handleVercelCreateOrder);
  app.post("/api/create-order.js", handleVercelCreateOrder);

  // API 3: Verify Order status details on Cashfree Gateway
  app.get("/api/cashfree/verify-order/:orderId", async (req, res) => {
    // Force response header to always be application/json
    res.setHeader("Content-Type", "application/json");

    const orderId = req.params.orderId;

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      return res.status(400).json({
        error: "COMMUNICATION_ERROR",
        message: "Cashfree credentials are not configured on the live server."
      });
    }

    const isProd = CASHFREE_ENV.toLowerCase() === "production" || CASHFREE_ENV.toLowerCase() === "live";
    const gatewayUrl = isProd
      ? `https://api.cashfree.com/pg/orders/${orderId}`
      : `https://sandbox.cashfree.com/pg/orders/${orderId}`;

    try {
      console.log(`[CASHFREE] Verifying order ID: ${orderId} using URL: ${gatewayUrl}`);

      const response = await fetch(gatewayUrl, {
        method: "GET",
        headers: {
          "x-api-version": "2023-08-01",
          "x-client-id": CASHFREE_APP_ID,
          "x-client-secret": CASHFREE_SECRET_KEY,
          "Content-Type": "application/json"
        }
      });

      const responseData = await response.json();

      if (!response.ok) {
        console.error("[CASHFREE] Verification Error Response:", responseData);
        return res.status(response.status).json({
          error: "GATEWAY_ERROR",
          message: responseData.message || "Failed to verify order on Cashfree server.",
          details: responseData
        });
      }

      console.log(`[CASHFREE] Order status verified: ${responseData.order_status}`);
      res.json(responseData);

    } catch (error: any) {
      console.error("[CASHFREE] Verification exception:", error);
      res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: error.message || "Connection failure during order status parsing."
      });
    }
  });

  // Global error handler middleware for Express specifically for API routes to force JSON instead of default HTML error screen
  app.use("/api", (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[GLOBAL_API_ERROR] Caught unhandled exception inside API Route:", err);
    res.status(500).setHeader("Content-Type", "application/json");
    res.json({
      error: "INTERNAL_SERVER_EXCEPTION",
      message: err.message || "A fatal routing or execution exception occurred in the payment processor module."
    });
  });

  // Serve static assets OR use Vite Dev Middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER_START] Fullstack server running on http://localhost:${PORT}`);
  });
}

startServer();
