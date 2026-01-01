import { firefox } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
let COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const DISCORD_RESPONSAVEL_ID = "1455692969322614895";

// teste: 5000 | produção: 300000 (5 min)
const INTERVALO = Number(process.env.INTERVALO_MS || "5000");

// TEST_MODE=1 => 1 evento já tenta exilar (pra teste)
const TEST_MODE = String(process.env.TEST_MODE || "1") === "1";

// regras (quando TEST_MODE=0)
const BURST_WINDOW_MS = 10_000;
const BURST_THRESHOLD = 3;

const VOLUME_WINDOW_MS = 300_000; // 5 min
const VOLUME_THRESHOLD = 10;

const PUNISH_COOLDOWN_MS = 30 * 60 * 1000;

// audit log (mais estável que /audit-log em muitos casos)
const AUDIT_URL = `https://www.roblox.com/groups/configure?id=${GROUP_ID}#!/auditLog`;
/* ========================================= */

if (!GROUP_ID || !COOKIE || !WEBHOOK || !OPENAI_KEY) {
  console.error("❌ Faltando env: GROUP_ID / ROBLOSECURITY / DISCORD_WEBHOOK / OPENAI_API_KEY");
  process.exit(1);
}

// sanitiza cookie
COOKIE = COOKIE.trim();
if ((COOKIE.startsWith('"') && COOKIE.endsWith('"')) || (COOKIE.startsWith("'") && COOKIE.endsWith("'"))) {
  COOKIE = COOKIE.slice(1, -1).trim();
}
if (COOKIE.startsWith(".ROBLOSECURITY=")) {
  COOKIE = COOKIE.replace(".ROBLOSECURITY=", "").trim();
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ================= ROBLOX CLIENT (KICK) ================= */
let csrfToken = null;
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0"
  },
  validateStatus: () => true
});

async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  if (csrfToken) roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
}

async function validarCookieHTTP() {
  const res = await axios.get("https://users.roblox.com/v1/users/authenticated", {
    headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` },
    validateStatus: () => true
  });
  return res.status === 200 ? res.data : null;
}

/* ====== resolver userId (username + fallback search) ====== */
async function usernameToUserId(username) {
  const res = await axios.post(
    "https://users.roblox.com/v1/usernames/users",
    { usernames: [username], excludeBannedUsers: false },
    { headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` }, validateStatus: () => true }
  );
  const id = res?.data?.data?.[0]?.id;
  return typeof id === "number" ? id : null;
}

async function searchNameToUserId(name) {
  const res = await axios.get(
    `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(name)}&limit=10`,
    { headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` }, validateStatus: () => true }
  );
  const data = res?.data?.data || [];
  const lower = String(name).toLowerCase();

  const exact = data.find(u =>
    String(u?.name || "").toLowerCase() === lower ||
    String(u?.displayName || "").toLowerCase() === lower
  );
  if (exact?.id) return exact.id;

  return data?.[0]?.id ?? null;
}

async function resolveUserId(actorText) {
  return (await usernameToUserId(actorText)) || (await searchNameToUserId(actorText));
}

async function kickFromGroup(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);

  // tenta renovar token e repetir uma vez
  if (res.status === 403 || res.status === 400) {
    await refreshCSRF();
    res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);
  }

  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    throw new Error(`Falha ao exilar (HTTP ${res.status}) ${body?.slice(0, 200) || ""}`);
  }
}
/* ========================================= */

/* ================= DISCORD (SÓ RELATÓRIO) ================= */
async function sendDiscord(content) {
  await axios.post(WEBHOOK, { content });
}

function formatRelatorioExilio(exilado) {
  const data = new Date().toLocaleDateString("pt-BR");
  return (
`***Relatório de Exílio!

Responsável: <@${DISCORD_RESPONSAVEL_ID}>

Exilado(a): ${exilado}

Motivo: Aceppt-all

Data: ${data}***`
  );
}
/* ========================================= */

/* ================= STATE ================= */
let running = false;
let lastImgHash = "";
let lastEventKeys = new Set();        // dedupe OCR keys
const actorTimes = new Map();         // actor -> timestamps
const punishedUntil = new Map();      // actor -> cooldownUntil
/* ========================================= */

/* ================= PLAYWRIGHT ================= */
let browser = null;
let context = null;
let page = null;

async function closeSilently() {
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  page = null; context = null; browser = null;
}

async function initBrowser() {
  await closeSilently();

  browser = await firefox.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  await context.addCookies([{
    name: ".ROBLOSECURITY",
    value: COOKIE,
    domain: ".roblox.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "None"
  }]);

  page = await context.newPage();

  await page.goto("https://www.roblox.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);

  const status = await page.evaluate(async () => {
    const r = await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" });
    return r.status;
  });

  if (status !== 200) {
    throw new Error("Cookie não logou no navegador (inválido/expirado/sem permissão).");
  }

  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
}

function sha256File(filepath) {
  const buf = fs.readFileSync(filepath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function capturarAudit() {
  if (!page || page.isClosed()) await initBrowser();

  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  } catch {
    await initBrowser();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  }

  await page.waitForTimeout(1200);
  await page.screenshot({ path: "audit.png" });
}
/* ========================================= */

/* ================= OCR ================= */
async function ocrAuditEvents() {
  const base64 = fs.readFileSync("audit.png").toString("base64");

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: 250,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text:
`Extraia SOMENTE eventos de aprovação/recusa de pedidos de entrada do Audit Log Roblox.
Retorne UMA linha por evento no formato:

ATOR | ACAO | QUANDO

- ACAO: aceitou ou recusou
- QUANDO: texto de tempo visível (ou "sem_tempo")

Se não houver, responda: SEM ALTERACOES`
        },
        { type: "input_image", image_url: `data:image/png;base64,${base64}` }
      ]
    }]
  });

  const text = (resp.output_text || "").trim();
  if (!text || text === "SEM ALTERACOES") return [];

  return text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => l.includes("|"))
    .map(l => {
      const [actor, action, when] = l.split("|").map(x => x.trim());
      return { actor, action: (action || "").toLowerCase(), when: when || "sem_tempo" };
    })
    .filter(e => e.actor && (e.action === "aceitou" || e.action === "recusou"));
}
/* ========================================= */

/* ================= DETECÇÃO ================= */
function now() { return Date.now(); }

function recordActor(actor) {
  const t = now();
  if (!actorTimes.has(actor)) actorTimes.set(actor, []);
  actorTimes.get(actor).push(t);

  // limpa > 5min
  const cutoff = t - VOLUME_WINDOW_MS;
  actorTimes.set(actor, actorTimes.get(actor).filter(x => x >= cutoff));
}

function shouldPunish(actor) {
  if (TEST_MODE) return true;

  const t = now();
  const arr = actorTimes.get(actor) || [];

  const burst = arr.filter(x => x >= t - BURST_WINDOW_MS).length;
  const vol = arr.length;

  return burst >= BURST_THRESHOLD || vol >= VOLUME_THRESHOLD;
}

function canPunish(actor) {
  return (punishedUntil.get(actor) || 0) <= now();
}

function markPunished(actor) {
  punishedUntil.set(actor, now() + PUNISH_COOLDOWN_MS);
}
/* ========================================= */

/* ================= PUNIÇÃO ================= */
async function punishActor(actor) {
  if (!canPunish(actor)) return;

  try {
    const userId = await resolveUserId(actor);
    if (!userId) throw new Error("Não consegui resolver userId (username/displayName).");

    await kickFromGroup(userId);

    // ✅ Só manda relatório se realmente exilou
    await sendDiscord(formatRelatorioExilio(actor));

    markPunished(actor);
  } catch (e) {
    // ❌ erro somente no console
    console.error(`⚠️ Falha ao punir/exilar ${actor}:`, String(e?.message || e));
  }
}
/* ========================================= */

/* ================= LOOP ================= */
async function monitorar() {
  if (running) return;
  running = true;

  try {
    await capturarAudit();

    const h = sha256File("audit.png");
    if (h === lastImgHash) {
      try { fs.unlinkSync("audit.png"); } catch {}
      return;
    }
    lastImgHash = h;

    const events = await ocrAuditEvents();

    try { fs.unlinkSync("audit.png"); } catch {}

    if (!events.length) return;

    // dedupe por "actor|action|when"
    const currentKeys = new Set(events.map(e => `${e.actor}|${e.action}|${e.when}`));
    const newKeys = [...currentKeys].filter(k => !lastEventKeys.has(k));
    lastEventKeys = currentKeys;

    if (!newKeys.length) return;

    for (const k of newKeys) {
      const [actor] = k.split("|").map(x => x.trim());

      recordActor(actor);

      if (shouldPunish(actor)) {
        await punishActor(actor);
      }
    }
  } catch (err) {
    console.error("Erro no monitor:", String(err?.message || err));
    try { await closeSilently(); } catch {}
  } finally {
    running = false;
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});

/* ================= START ================= */
(async () => {
  const me = await validarCookieHTTP();
  if (!me) {
    console.error("❌ ROBLOSECURITY inválido/expirado. Corrija e redeploy.");
    process.exit(1);
  }

  await refreshCSRF();
  await initBrowser();

  console.log(`🛡️ Rodando | TEST_MODE=${TEST_MODE} | INTERVALO=${INTERVALO}ms`);
  setInterval(monitorar, INTERVALO);
})();
