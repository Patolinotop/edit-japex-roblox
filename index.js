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

// Intervalo (teste: 5000; produção: 300000)
const INTERVALO = Number(process.env.INTERVALO_MS || "5000");

// Test mode: 1 ação já exila
const TEST_MODE = String(process.env.TEST_MODE || "1") === "1";

// Anti-spam normal (quando TEST_MODE=0)
const WINDOW_BURST_MS = 10_000;     // janela curta
const BURST_THRESHOLD = 3;          // 3 ações em 10s
const VOLUME_WINDOW_MS = 300_000;   // 5 min
const VOLUME_THRESHOLD = 10;        // 10 ações em 5 min

const PUNISH_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

const DEBUG_EXILE = String(process.env.DEBUG_EXILE || "0") === "1";

// URL do audit log
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

// Roblox client (exílio)
let csrfToken = null;
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
    "Referer": `https://www.roblox.com/groups/${GROUP_ID}/audit-log`
  },
  validateStatus: () => true
});

// Estado
let running = false;
let lastImgHash = "";
let lastParsedLines = new Set(); // linhas OCR anteriores
const actorEvents = new Map();   // actor -> [timestamps]
const punishedUntil = new Map(); // actor -> timestampUntil

// Browser reusável
let browser = null;
let context = null;
let page = null;

/* ================= DISCORD ================= */
async function sendDiscord(content) {
  try {
    await axios.post(WEBHOOK, { content });
  } catch (e) {
    console.error("Erro webhook:", e?.message || e);
  }
}

function formatRelatorioExilio(exiladoUsername) {
  const data = new Date().toLocaleDateString("pt-BR");
  return (
`***Relatório de Exílio!

Responsável: <@${DISCORD_RESPONSAVEL_ID}>

Exilado(a): ${exiladoUsername}

Motivo: Aceppt-all

Data: ${data}***`
  );
}
/* ========================================= */

/* ================= UTIL: PEGAR USERNAME REAL ================= */
/**
 * Queremos SEMPRE o username real (o que aparece com @ no log).
 * Se vier "@camillygamer_01" -> "camillygamer_01"
 * Se vier "cami_hudson (@camillygamer_01)" -> "camillygamer_01"
 * Se não tiver @, usa o token “mais provável” (fallback) — mas o OCR foi ajustado pra sempre usar @.
 */
function normalizeUsernameFromActor(raw) {
  const s = String(raw || "").trim();

  // pega @username se existir
  const m = s.match(/@([A-Za-z0-9_]{3,20})/);
  if (m?.[1]) return m[1];

  // se já vier no formato username
  const token = s.replace(/^@/, "").trim();
  // (fallback) corta espaços e caracteres estranhos
  return token.split(/\s+/)[0].replace(/[^A-Za-z0-9_]/g, "");
}
/* ========================================= */

/* ================= ROBLOX CSRF / EXILAR ================= */
async function refreshCSRF() {
  try { delete roblox.defaults.headers.common["X-CSRF-TOKEN"]; } catch {}
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  const token = res.headers["x-csrf-token"];
  if (!token) throw new Error("Não consegui obter x-csrf-token");
  csrfToken = token;
  roblox.defaults.headers.common["X-CSRF-TOKEN"] = csrfToken;
}

async function usernameToUserId(username) {
  const res = await axios.post(
    "https://users.roblox.com/v1/usernames/users",
    { usernames: [username], excludeBannedUsers: false },
    {
      headers: { Cookie: `.ROBLOSECURITY=${COOKIE}`, "Content-Type": "application/json" },
      validateStatus: () => true
    }
  );

  const id = res?.data?.data?.[0]?.id;
  return typeof id === "number" ? id : null;
}

async function isUserInGroup(userId) {
  const res = await axios.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`, {
    headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` },
    validateStatus: () => true
  });

  if (res.status !== 200 || !res.data?.data) return false;
  return res.data.data.some(item => item?.group?.id === Number(GROUP_ID));
}

async function exilarUsuarioPorId(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);
  if (res.status === 403) {
    await refreshCSRF();
    res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);
  }

  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    throw new Error(`Falha ao exilar (HTTP ${res.status}) body=${body}`);
  }
}
/* ========================================= */

/* ================= AUTH CHECK ================= */
async function validarCookieHTTP() {
  const res = await axios.get("https://users.roblox.com/v1/users/authenticated", {
    headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` },
    validateStatus: () => true
  });
  return res.status === 200;
}
/* ========================================= */

/* ================= PLAYWRIGHT ================= */
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
  if (status !== 200) throw new Error("Cookie não logou no navegador (inválido/expirado/sem permissão).");

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

  await page.waitForTimeout(1800);
  await page.screenshot({ path: "audit.png" });
}
/* ========================================= */

/* ================= OPENAI OCR ================= */
async function ocrAuditToLines() {
  const base64 = fs.readFileSync("audit.png").toString("base64");

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: 240,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
`Você está vendo um Audit Log de grupo Roblox.

Na coluna "Usuário" aparece:
- Em cima: Display Name
- Em baixo: @username (o username REAL)

Regra OBRIGATÓRIA:
✅ Sempre use o @username REAL (o de baixo) e retorne SEM o "@".

Extraia SOMENTE eventos de aprovação/recusa de pedidos de entrada.
Retorne UMA linha por evento no formato:

USERNAME_REAL | ACAO

Onde ACAO é apenas: "aceitou" ou "recusou".

Exemplos:
camillygamer_01 | aceitou
lalomaio | recusou

Se não houver eventos desse tipo visíveis, responda exatamente:
SEM ALTERACOES`
          },
          { type: "input_image", image_url: `data:image/png;base64,${base64}` }
        ]
      }
    ]
  });

  const text = (resp.output_text || "").trim();
  if (!text || text === "SEM ALTERACOES") return [];

  return text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => l.includes("|"))
    .map(l => {
      const [actorRaw, actionRaw] = l.split("|").map(x => x.trim());
      const actor = normalizeUsernameFromActor(actorRaw); // ✅ força username real
      const action = (actionRaw || "").toLowerCase();
      return `${actor} | ${action}`;
    });
}
/* ========================================= */

/* ================= DETECÇÃO + PUNIÇÃO ================= */
function nowMs() { return Date.now(); }

function canPunish(actor) {
  const until = punishedUntil.get(actor) || 0;
  return nowMs() >= until;
}

function markPunished(actor) {
  punishedUntil.set(actor, nowMs() + PUNISH_COOLDOWN_MS);
}

function recordEvent(actor) {
  const t = nowMs();
  if (!actorEvents.has(actor)) actorEvents.set(actor, []);
  actorEvents.get(actor).push(t);

  const cutoff = t - VOLUME_WINDOW_MS;
  actorEvents.set(actor, actorEvents.get(actor).filter(x => x >= cutoff));
  return actorEvents.get(actor);
}

function shouldPunish(actor) {
  if (TEST_MODE) return true;

  const t = nowMs();
  const arr = actorEvents.get(actor) || [];

  const burst = arr.filter(x => x >= t - WINDOW_BURST_MS).length;
  const volume = arr.length;

  return burst >= BURST_THRESHOLD || volume >= VOLUME_THRESHOLD;
}

async function punishActor(actorUsername) {
  if (!canPunish(actorUsername)) return;

  const userId = await usernameToUserId(actorUsername);
  if (!userId) {
    await sendDiscord(formatRelatorioExilio(actorUsername) + `\n\n(⚠️ Não consegui resolver userId.)`);
    markPunished(actorUsername);
    return;
  }

  const inGroup = await isUserInGroup(userId);
  if (!inGroup) {
    if (DEBUG_EXILE) {
      await sendDiscord(`⚠️ DEBUG: "${actorUsername}" (id ${userId}) não aparece como membro do grupo. Evitei exílio.`);
    }
    return;
  }

  try {
    await exilarUsuarioPorId(userId);
    await sendDiscord(formatRelatorioExilio(actorUsername));
    markPunished(actorUsername);
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("Erro exilar:", msg);
    if (DEBUG_EXILE) await sendDiscord(`⚠️ DEBUG EXILE: ${msg}`.slice(0, 1900));
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

    const lines = await ocrAuditToLines();
    try { fs.unlinkSync("audit.png"); } catch {}

    if (!lines.length) return;

    // diff: só processa linhas novas
    const newLines = lines.filter(l => !lastParsedLines.has(l));
    lastParsedLines = new Set(lines);

    if (!newLines.length) return;

    for (const l of newLines) {
      const [actorRaw, actionRaw] = l.split("|").map(x => x.trim());
      const actor = normalizeUsernameFromActor(actorRaw); // ✅ garante handle real
      const action = (actionRaw || "").toLowerCase();

      if (!actor) continue;
      if (action !== "aceitou" && action !== "recusou") continue;

      recordEvent(actor);

      if (shouldPunish(actor)) {
        await punishActor(actor);
      }
    }

  } catch (err) {
    console.error("Erro no monitor:", err?.message || err);
    try { await closeSilently(); } catch {}
  } finally {
    running = false;
  }
}

(async () => {
  const ok = await validarCookieHTTP();
  if (!ok) {
    await sendDiscord("❌ ROBLOSECURITY inválido/expirado. Atualize o cookie.");
    process.exit(1);
  }

  await refreshCSRF();
  await initBrowser();

  console.log(`🛡️ Anti Accept/Recuse-all ATIVO | TEST_MODE=${TEST_MODE} | INTERVALO=${INTERVALO}ms`);
  setInterval(monitorar, INTERVALO);
})();
