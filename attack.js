const http = require("http");
const readline = require("readline");

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "localhost",
        port: process.env.PORT || 3000,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function fmt(paise) {
  return "₹" + (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

async function run() {
  const CURRENCY = process.env.CURRENCY || "INR";

  console.log("\n╔════════════════════════════════════════╗");
  console.log("║   PayGuard · Attack Demo               ║");
  console.log("╚════════════════════════════════════════╝\n");

  // ── Step 1: Ask user which product to attack ──────────────────────────────
  console.log("Available products:");
  console.log("  [1] First Flush Darjeeling  — ₹1,499  (P001)");
  console.log("  [2] Assam Gold TGFOP        — ₹899    (P002)");
  console.log("  [3] Nilgiri Frost Tea       — ₹1,999  (P003)");
  console.log("  [4] Kerala Green Pearl      — ₹1,299  (P004)\n");

  const productChoice = await ask("Pick a product [1-4, default 1]: ");
  const productMap = { "1": "P001", "2": "P002", "3": "P003", "4": "P004" };
  const productId = productMap[productChoice] || "P001";

  const qtyStr = await ask("Quantity [default 1]: ");
  const qty = parseInt(qtyStr) || 1;

  // ── Step 2: Ask for tamper amount ─────────────────────────────────────────
  console.log("\nTamper options:");
  console.log("  [1] ₹1     (1 paise — classic attack)");
  console.log("  [2] ₹0     (zero price)");
  console.log("  [3] ₹-1    (negative price)");
  console.log("  [4] Custom amount\n");

  const tamperChoice = await ask("Pick tamper amount [1-4, default 1]: ");
  let tamperedTotal;
  if (tamperChoice === "2") {
    tamperedTotal = 0;
  } else if (tamperChoice === "3") {
    tamperedTotal = -100;
  } else if (tamperChoice === "4") {
    const custom = await ask("Enter tampered amount in ₹ (e.g. 10): ");
    tamperedTotal = Math.round(parseFloat(custom) * 100) || 1;
  } else {
    tamperedTotal = 1; // default: 1 paise
  }

  console.log(`\n──────────────────────────────────────────`);
  console.log(`Product:        ${productId} × ${qty}`);
  console.log(`Tampered total: ${fmt(tamperedTotal)}`);
  console.log(`──────────────────────────────────────────\n`);

  // ── Step 3: Create a signed cart ──────────────────────────────────────────
  console.log("Step 1 › Create a legitimate signed cart from server...\n");

  const createResp = await postJson("/cart/create", {
    items: [{ id: productId, qty }],
    currency: CURRENCY,
  });

  if (!createResp.body.cart || !createResp.body.signature) {
    console.error("✗ Could not create cart. Is the server running on port " + (process.env.PORT || 3000) + "?");
    process.exit(1);
  }

  const { cart, signature } = createResp.body;
  console.log(`  Real total:     ${fmt(cart.total)}`);
  console.log(`  Signature:      ${signature.slice(0, 24)}...`);
  console.log(`  Transaction ID: ${cart.transaction_id}\n`);

  // ── Step 4: ATTACK — tamper total, keep old signature ─────────────────────
  console.log("Step 2 › ATTACK — swap total to " + fmt(tamperedTotal) + " but keep original signature...\n");

  const tamperedCart = { ...cart, total: tamperedTotal };

  // Get a fresh transaction_id for the tampered attempt
  const attackCartResp = await postJson("/cart/create", {
    items: [{ id: productId, qty }],
    currency: CURRENCY,
  });

  const checkoutResp = await postJson("/checkout", {
    cart: tamperedCart,
    signature,                                  // ← original sig, wrong for tampered cart
    transaction_id: attackCartResp.body.transaction_id
  });

  const blocked = checkoutResp.status === 403 || checkoutResp.body.code === "TAMPERED_CART";
  console.log(`  Status:  ${checkoutResp.status}`);
  console.log(`  Result:  ${blocked ? "🛡  BLOCKED — " + checkoutResp.body.error : "⚠  PASSED (unexpected!)"}\n`);

  // ── Step 5: Legitimate checkout ───────────────────────────────────────────
  console.log("Step 3 › Legitimate checkout with the real cart & signature...\n");

  const validResp = await postJson("/cart/create", {
    items: [{ id: productId, qty }],
    currency: CURRENCY,
  });
  const { transaction_id: validTxn, signature: validSig, cart: validCart } = validResp.body;

  const goodCheckout = await postJson("/checkout", {
    cart: validCart,
    signature: validSig,
    transaction_id: validTxn
  });

  const ok = goodCheckout.body.success;
  console.log(`  Status:   ${goodCheckout.status}`);
  console.log(`  Order ID: ${goodCheckout.body.orderId || "—"}`);
  console.log(`  Amount:   ${fmt(goodCheckout.body.paymentAmount || 0)}`);
  console.log(`  Result:   ${ok ? "✅ ACCEPTED — legitimate order went through" : "✗ Failed unexpectedly"}\n`);

  console.log("══════════════════════════════════════════");
  console.log(blocked && ok
    ? "  ✅  Security working correctly."
    : "  ⚠   Something unexpected happened — check server logs.");
  console.log("══════════════════════════════════════════\n");
}

run().catch(err => { console.error(err); process.exit(1); });
