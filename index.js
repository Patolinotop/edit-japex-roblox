import { firefox } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
let COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const DISCORD_RESPONSAVEL_ID = "1455692969322614895";

const INTERVALO = Number(process.env.INTERVALO_MS || "5000");
const TEST_MODE = String(process.env.TEST_MODE || "1") === "1";

const BURST_WINDOW_MS = 10_000;
const BURST_THRESHOLD = 3;

const VOLUME_WINDOW_MS = 300_000;
const VOLUME_THRESHOLD = 10;

const PUNISH_COOLDOWN_MS = 30 * 60 * 1000;

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

/* ================= DISCORD (SÓ SUCESSO) ================= */
async function sendDiscord(content) {
  await axios.post(WEBHOOK, { content });
}

function formatRelatorioExilio(usernameSemArroba) {
  const data = new Date().toLocaleDateString("pt-BR");
  return (
`***Relatório de Exílio!

Responsável: <@${DISCORD_RESPONSAVEL_ID}>

Exilado(a): ${usernameSemArroba}

Motivo: Aceppt-all

Data: ${data}***`
  );
}
/* ========================================= */

/* ================= STATE ================= */
let running = false;
let lastImgHash = "";
let lastEventKeys = new Set();
const actorTimes = new Map();
const punishedUntil = new Map();

// baseline: primeira leitura não pune
let baselineReady = false;
/* ========================================= */

/* ================= PLAYWRIGHT RUNTIME FALLBACK ================= */
function ensurePlaywrightBrowsersInstalled() {
  try {
    console.log("🔧 Verificando/instalando browsers do Playwright...");
    execSync("npx playwright --version", { stdio: "inherit" });
    execSync("npx playwright install firefox", { stdio: "inherit" });
    console.log("✅ Browser Firefox pronto.");
  } catch (e) {
    console.error("❌ Falha ao instalar browsers via npx playwright install firefox.");
    console.error(String(e?.message || e));
    process.exit(1);
  }
}
/* ========================================= */

/* ================= PLAYWRIGHT ================= */
let browser = null;
let context = null;
let page = null;

// API request do Playwright (usa cookies do contexto)
let api = null;
let csrfToken = null;

async function closeSilently() {
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  page = null; context = null; browser = null; api = null; csrfToken = null;
}

async function refreshCSRF_viaPlaywright() {
  const res = await api.post("https://auth.roblox.com/v2/logout");
  const token = res.headers()["x-csrf-token"];
  if (!token) throw new Error("Não consegui obter X-CSRF-TOKEN.");
  csrfToken = token;
}

async function validarAuth_viaPlaywright() {
  const res = await api.get("https://users.roblox.com/v1/users/authenticated");
  return res.status();
}

async function initBrowser() {
  await closeSilently();

  try {
    browser = await firefox.launch({ headless: true });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("Executable doesn't exist")) {
      console.error("⚠️ Firefox não encontrado. Instalando em runtime...");
      ensurePlaywrightBrowsersInstalled();
      browser = await firefox.launch({ headless: true });
    } else {
      throw e;
    }
  }

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

  api = context.request;
  page = await context.newPage();

  await page.goto("https://www.roblox.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);

  // valida auth pelo próprio request (evita mismatch axios vs browser)
  const s = await validarAuth_viaPlaywright();
  if (s !== 200) throw new Error(`Cookie não autenticou (status ${s}). Troque o ROBLOSECURITY.`);

  await refreshCSRF_viaPlaywright();

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
`Você está vendo o Audit Log de uma comunidade/grupo Roblox.

Extraia SOMENTE eventos relacionados a pedidos de entrada (aceitou/recusou).
IMPORTANTE: Se aparecer "DisplayName" e abaixo "@username", use SEMPRE o username (sem @).

Retorne UMA linha por evento no formato:

USERNAME | ACAO | QUANDO

- USERNAME: sem @, exemplo: cami_hudzinha
- ACAO: aceitou ou recusou
- QUANDO: texto de tempo visível (ou "sem_tempo")

Se não houver eventos desse tipo visíveis, responda exatamente:
SEM ALTERACOES`
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
      const [username, action, when] = l.split("|").map(x => x.trim());
      const u = (username || "").replace(/^@/g, "").trim();
      return { username: u, action: (action || "").toLowerCase(), when: when || "sem_tempo" };
    })
    .filter(e => e.username && (e.action === "aceitou" || e.action === "recusou"));
}
/* ========================================= */

/* ================= RESOLVE USERID ================= */
async function usernameToUserId(username) {
  const res = await api.post("https://users.roblox.com/v1/usernames/users", {
    data: { usernames: [username], excludeBannedUsers: false }
  });

  if (!res.ok()) return null;

  const body = await res.json();
  const id = body?.data?.[0]?.id;
  return typeof id === "number" ? id : null;
}

async function resolveUserId(usernameSemArroba) {
  // aqui já é username real (sem @). Se falhar, não tenta displayName.
  return await usernameToUserId(usernameSemArroba);
}
/* ========================================= */

/* ================= KICK (via Playwright request) ================= */
async function kickFromGroup(userId) {
  if (!csrfToken) await refreshCSRF_viaPlaywright();

  let res = await api.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`, {
    headers: { "x-csrf-token": csrfToken }
  });

  // se CSRF venceu, renova e tenta 1x
  if (res.status() === 403) {
    await refreshCSRF_viaPlaywright();
    res = await api.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`, {
      headers: { "x-csrf-token": csrfToken }
    });
  }

  if (res.status() === 401) {
    throw new Error(`Falha ao exilar (HTTP 401) User is not authenticated — cookie expirou ou Roblox derrubou a sessão.`);
  }

  if (res.status() < 200 || res.status() >= 300) {
    let body = "";
    try { body = JSON.stringify(await res.json()).slice(0, 220); } catch {}
    throw new Error(`Falha ao exilar (HTTP ${res.status()}) ${body}`);
  }
}
/* ========================================= */

/* ================= DETECÇÃO ================= */
function now() { return Date.now(); }

function recordActor(actor) {
  const t = now();
  if (!actorTimes.has(actor)) actorTimes.set(actor, []);
  actorTimes.get(actor).push(t);

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

/* ================= PUNIÇÃO (Discord só sucesso) ================= */
async function punishActor(usernameSemArroba) {
  if (!canPunish(usernameSemArroba)) return;

  try {
    const userId = await resolveUserId(usernameSemArroba);
    if (!userId) throw new Error(`Não consegui resolver userId para username "${usernameSemArroba}".`);

    await kickFromGroup(userId);

    await sendDiscord(formatRelatorioExilio(usernameSemArroba));
    markPunished(usernameSemArroba);
  } catch (e) {
    console.error(`⚠️ Falha ao exilar ${usernameSemArroba}:`, String(e?.message || e));
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

    // baseline: primeira leitura não pune
    if (!baselineReady) {
      lastEventKeys = new Set(events.map(e => `${e.username}|${e.action}|${e.when}`));
      baselineReady = true;
      console.log("✅ Baseline setado. A partir da próxima mudança o bot começa a agir.");
      return;
    }

    if (!events.length) return;

    const currentKeys = new Set(events.map(e => `${e.username}|${e.action}|${e.when}`));
    const newKeys = [...currentKeys].filter(k => !lastEventKeys.has(k));
    lastEventKeys = currentKeys;

    if (!newKeys.length) return;

    for (const k of newKeys) {
      const [username] = k.split("|").map(x => x.trim());

      recordActor(username);

      if (shouldPunish(username)) {
        await punishActor(username);
      }
    }
  } catch (err) {
    console.error("Erro no monitor:", String(err?.message || err));
    try { await closeSilently(); } catch {}
  } finally {
    running = false;
  }
}

process.on("unhandledRejection", (reason) => console.error("UnhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

/* ================= START ================= */
(async () => {
  await initBrowser();

  console.log(`🛡️ Rodando | TEST_MODE=${TEST_MODE} | INTERVALO=${INTERVALO}ms`);
  console.log("ℹ️ Primeira captura = baseline (não pune ninguém).");

  // seta baseline logo no começo
  await monitorar();

  setInterval(monitorar, INTERVALO);
})();
