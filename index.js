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

// Sempre marcar esse responsável no Discord
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

// Cooldown pra não exilar/spammar o mesmo cara múltiplas vezes
const PUNISH_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

// URL do audit log (mais estável que /audit-log em muitos casos)
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

// Roblox client (pra exilar)
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
let lastParsedLines = new Set();         // linhas OCR anteriores (pra diff)
const actorEvents = new Map();           // actor -> [timestamps]
const punishedUntil = new Map();         // actor -> timestampUntil

// Browser reusável
let browser = null;
let context = null;
let page = null;

/* ================= DISCORD ================= */
async function sendDiscord(content) {
  await axios.post(WEBHOOK, { content });
}

function formatRelatorioExilio(exiladoUsername) {
  // exatamente como você pediu (com *** no começo e no fim)
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

/* ================= ROBLOX CSRF / EXILAR ================= */
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  if (csrfToken) roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
}

async function usernameToUserId(username) {
  // https://users.roblox.com/v1/usernames/users
  const res = await axios.post(
    "https://users.roblox.com/v1/usernames/users",
    {
      usernames: [username],
      excludeBannedUsers: false
    },
    {
      headers: { Cookie: `.ROBLOSECURITY=${COOKIE}`, "Content-Type": "application/json" },
      validateStatus: () => true
    }
  );

  const id = res?.data?.data?.[0]?.id;
  return typeof id === "number" ? id : null;
}

async function exilarUsuarioPorId(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);

  if (res.status === 403) {
    await refreshCSRF();
    res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Falha ao exilar (HTTP ${res.status})`);
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

  // abre home primeiro pra “assentar” cookies
  await page.goto("https://www.roblox.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);

  // confere login no navegador
  const status = await page.evaluate(async () => {
    const r = await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" });
    return r.status;
  });
  if (status !== 200) throw new Error("Cookie não logou no navegador (inválido/expirado/sem permissão).");

  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
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

  await page.waitForTimeout(2000);
  await page.screenshot({ path: "audit.png" });
}
/* ========================================= */

/* ================= OPENAI OCR ================= */
async function ocrAuditToLines() {
  const base64 = fs.readFileSync("audit.png").toString("base64");

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: 250,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
`Você está vendo um Audit Log de grupo Roblox.

Extraia SOMENTE eventos de aprovação/recusa de pedidos de entrada.
Retorne UMA linha por evento no formato:

ATOR | ACAO

Onde ACAO é apenas: "aceitou" ou "recusou".

Exemplos:
cami_hudson | aceitou
moderadorX | recusou

Se não houver eventos desse tipo visíveis, responda exatamente:
SEM ALTERACOES`
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${base64}`
          }
        ]
      }
    ]
  });

  const text = (resp.output_text || "").trim();
  if (!text || text === "SEM ALTERACOES") return [];

  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => l.includes("|"));

  // normaliza
  return lines.map(l => {
    const [actor, action] = l.split("|").map(x => x.trim());
    return `${actor} | ${action}`; // garante formato
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

  // limpa históricos muito antigos (5 min)
  const cutoff = t - VOLUME_WINDOW_MS;
  const arr = actorEvents.get(actor).filter(x => x >= cutoff);
  actorEvents.set(actor, arr);

  return arr;
}

function shouldPunish(actor) {
  if (TEST_MODE) return true;

  const t = nowMs();
  const arr = actorEvents.get(actor) || [];

  const burstCount = arr.filter(x => x >= t - WINDOW_BURST_MS).length;
  const volumeCount = arr.filter(x => x >= t - VOLUME_WINDOW_MS).length;

  return burstCount >= BURST_THRESHOLD || volumeCount >= VOLUME_THRESHOLD;
}

async function punishActor(actorUsername) {
  if (!canPunish(actorUsername)) return;

  // resolve userId
  const userId = await usernameToUserId(actorUsername);
  if (!userId) {
    // ainda manda relatório (pra você ver que detectou) se não conseguir ID
    await sendDiscord(formatRelatorioExilio(actorUsername) + `\n\n(⚠️ Não consegui resolver userId para exilar automaticamente.)`);
    markPunished(actorUsername);
    return;
  }

  // exila no Roblox
  await exilarUsuarioPorId(userId);

  // manda relatório do jeito EXATO
  await sendDiscord(formatRelatorioExilio(actorUsername));

  markPunished(actorUsername);
}
/* ========================================= */

/* ================= LOOP ================= */
async function monitorar() {
  if (running) return;
  running = true;

  try {
    await capturarAudit();

    // compara com anterior por hash (só “1 anterior” na prática)
    const h = sha256File("audit.png");
    if (h === lastImgHash) {
      try { fs.unlinkSync("audit.png"); } catch {}
      return;
    }
    lastImgHash = h;

    const lines = await ocrAuditToLines();

    // apaga sempre
    try { fs.unlinkSync("audit.png"); } catch {}

    if (!lines.length) return;

    // diff: só processa linhas novas (evita 40 mensagens)
    const newLines = lines.filter(l => !lastParsedLines.has(l));

    // atualiza “anterior” para próxima comparação lógica
    lastParsedLines = new Set(lines);

    if (!newLines.length) return;

    // registra eventos por ator e pune só quando necessário
    for (const l of newLines) {
      const [actorRaw, actionRaw] = l.split("|").map(x => x.trim());
      const actor = actorRaw;
      const action = (actionRaw || "").toLowerCase();

      // só conta aceitou/recusou
      if (action !== "aceitou" && action !== "recusou") continue;

      recordEvent(actor);

      // no modo teste: 1 evento já exila
      // no modo normal: só se burst/volume
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
  // valida cookie antes de torrar OpenAI
  const ok = await validarCookieHTTP();
  if (!ok) {
    await sendDiscord("❌ ROBLOSECURITY inválido/expirado. Atualize o cookie.");
    process.exit(1);
  }

  await refreshCSRF();     // prepara CSRF para exílio
  await initBrowser();     // prepara browser

  console.log(`🛡️ Anti Accept/Recuse-all ATIVO | TEST_MODE=${TEST_MODE} | INTERVALO=${INTERVALO}ms`);
  setInterval(monitorar, INTERVALO);
})();
