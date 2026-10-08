const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ─── HMAC SECURITY ────────────────────────────────────────────────────────────
const CART_SECRET = process.env.CART_SECRET || "sampurnitea-hmac-secret-change-in-prod";

function signCart(cart) {
  return crypto.createHmac("sha256", CART_SECRET).update(JSON.stringify(cart)).digest("hex");
}
function verifyCart(cart, signature) {
  const expected = signCart(cart);
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

// ─── IN-MEMORY STORES ─────────────────────────────────────────────────────────
const orders = new Map();
const transactions = new Map();

// ─── SECURITY EVENT LOG ───────────────────────────────────────────────────────
const securityLog = [];
const sseClients = new Set();

function logSecurityEvent(event) {
  securityLog.unshift(event); // newest first
  if (securityLog.length > 200) securityLog.pop();
  // Push to all SSE clients
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
const products = [
  { id: "P001", name: "First Flush Darjeeling", subtitle: "Spring harvest · 2026", price: 149900, weight: "250g", rating: 4.8, reviews: 2341, tag: "Bestseller", img: "https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=600&q=80", desc: "The champagne of teas." },
  { id: "P002", name: "Assam Gold TGFOP", subtitle: "Premium estate · Malty", price: 89900, weight: "500g", rating: 4.6, reviews: 1892, tag: "Popular", img: "https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=600&q=80", desc: "Bold, brisk and malty." },
  { id: "P003", name: "Nilgiri Frost Tea", subtitle: "Winter frost · Rare", price: 199900, weight: "100g", rating: 4.9, reviews: 567, tag: "Rare", img: "https://images.unsplash.com/photo-1627435601361-ec25f5b1d0e5?w=600&q=80", desc: "Harvested only during the winter frost season." },
  { id: "P004", name: "Kerala Green Pearl", subtitle: "Unoxidised · Antioxidant", price: 129900, weight: "200g", rating: 4.5, reviews: 1203, tag: "Organic", img: "https://images.unsplash.com/photo-1563822249366-3efb23b8e0c9?w=600&q=80", desc: "Hand-rolled green tea from the Wayanad hills." },
];

const SKU_ALIASES = { "sku_premium": "P001" };

function computeServerTotal(items) {
  let subtotal = 0;
  for (const item of items) {
    const resolvedId = SKU_ALIASES[item.id] || item.id;
    const product = products.find(p => p.id === resolvedId);
    if (!product) throw new Error("Unknown product: " + item.id);
    if (!Number.isInteger(item.qty) || item.qty < 1) throw new Error("Invalid qty for " + item.id);
    subtotal += product.price * item.qty;
  }
  const shipping = subtotal >= 99900 ? 0 : 9900;
  return subtotal + shipping;
}

// ─── PAGES ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/product/:id", (req, res) => res.sendFile(path.join(__dirname, "public", "product.html")));
app.get("/cart", (req, res) => res.sendFile(path.join(__dirname, "public", "cart.html")));
app.get("/checkout", (req, res) => res.sendFile(path.join(__dirname, "public", "checkout.html")));
app.get("/payment", (req, res) => res.sendFile(path.join(__dirname, "public", "payment.html")));
app.get("/order-success", (req, res) => res.sendFile(path.join(__dirname, "public", "success.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

// ─── PRODUCTS API ─────────────────────────────────────────────────────────────
app.get("/api/products", (req, res) => res.json(products));
app.get("/api/products/:id", (req, res) => {
  const p = products.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
});

// ─── DASHBOARD: SSE live stream ───────────────────────────────────────────────
app.get("/api/dashboard/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Send current log immediately
  res.write(`data: ${JSON.stringify({ type: "init", log: securityLog })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ─── DASHBOARD: Stats snapshot ────────────────────────────────────────────────
app.get("/api/dashboard/stats", (req, res) => {
  const accepted = securityLog.filter(e => e.result === "ACCEPTED").length;
  const rejected = securityLog.filter(e => e.result === "REJECTED").length;
  res.json({ accepted, rejected, total: securityLog.length, log: securityLog });
});

// ─── CART CREATE ──────────────────────────────────────────────────────────────
app.post(["/cart/create", "/api/cart/create"], (req, res) => {
  const { items, currency = "INR" } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "Missing or empty items" });

  let total;
  try { total = computeServerTotal(items); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const transaction_id = crypto.randomUUID();
  const cart = { items, total, currency, transaction_id };
  const signature = signCart(cart);
  transactions.set(transaction_id, { cart, used: false });

  res.json({ cart, signature, transaction_id });
});

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────
app.post(["/checkout", "/api/orders/create"], (req, res) => {
  const { cart, signature, address, paymentMethod, transaction_id } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const ts = new Date().toISOString();

  if (!cart || !signature) {
    return res.status(400).json({ error: "Missing cart or signature" });
  }

  // 1. HMAC check
  let valid;
  try { valid = verifyCart(cart, signature); }
  catch {
    logSecurityEvent({ type: "INVALID_SIG_FORMAT", result: "REJECTED", ip, ts, cart, reason: "Bad signature format" });
    return res.status(400).json({ error: "Invalid signature format" });
  }

  if (!valid) {
    logSecurityEvent({
      type: "TAMPERED_CART", result: "REJECTED", ip, ts,
      attempted_total: cart.total,
      reason: "HMAC signature mismatch — price tampering detected",
      items: cart.items,
    });
    return res.status(403).json({ error: "Cart signature mismatch — price tampering detected", code: "TAMPERED_CART" });
  }

  // 2. Server-side total re-verification
  let serverTotal;
  try { serverTotal = computeServerTotal(cart.items); }
  catch (e) {
    logSecurityEvent({ type: "BAD_ITEMS", result: "REJECTED", ip, ts, reason: e.message });
    return res.status(400).json({ error: e.message });
  }

  if (serverTotal !== cart.total) {
    logSecurityEvent({ type: "TOTAL_MISMATCH", result: "REJECTED", ip, ts, attempted_total: cart.total, expected_total: serverTotal, reason: "Server recalculation differs" });
    return res.status(403).json({ error: "Total mismatch", code: "TOTAL_MISMATCH" });
  }

  // 3. Replay protection
  const txId = cart.transaction_id || transaction_id;
  if (txId) {
    const txn = transactions.get(txId);
    if (!txn) {
      logSecurityEvent({ type: "UNKNOWN_TXN", result: "REJECTED", ip, ts, reason: "Unknown transaction ID" });
      return res.status(400).json({ error: "Unknown transaction" });
    }
    if (txn.used) {
      logSecurityEvent({ type: "REPLAY_ATTACK", result: "REJECTED", ip, ts, transaction_id: txId, reason: "Transaction ID reused — replay attack" });
      return res.status(400).json({ error: "Transaction already used", code: "REPLAY_ATTACK" });
    }
    txn.used = true;
  }

  // 4. All clear
  const orderId = "ORD" + Date.now();
  const order = {
    id: orderId, items: cart.items, address: address || {},
    total: cart.total, currency: cart.currency || "INR",
    paymentMethod: paymentMethod || "upi", status: "pending",
    createdAt: ts,
  };
  orders.set(orderId, order);

  logSecurityEvent({
    type: "CHECKOUT", result: "ACCEPTED", ip, ts,
    orderId, total: cart.total, currency: cart.currency,
    items: cart.items,
  });

  res.json({ success: true, orderId, paymentAmount: order.total, currency: order.currency, upiId: "sampurni@paytm", upiName: "Sampurni Teas Pvt Ltd" });
});

// ─── ORDER API ────────────────────────────────────────────────────────────────
app.post("/api/orders/:id/confirm", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  order.status = "confirmed";
  res.json({ success: true, order });
});

app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Not found" });
  res.json(order);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log("\n🍵  SampurniTea Shop      → http://localhost:" + PORT);
  console.log("📊  Security Dashboard    → http://localhost:" + PORT + "/dashboard");
  console.log("🔐  HMAC cart signing:  ACTIVE");
  console.log("🛡   Replay protection:  ACTIVE");
  console.log("\nRun security test:\n   PORT=" + PORT + " node attack.js\n");
});
