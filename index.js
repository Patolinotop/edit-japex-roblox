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

const INTERVALO = Number(process.env.INTERVALO_MS || "5000");
const TEST_MODE = String(process.env.TEST_MODE || "1") === "1";

// regras (quando TEST_MODE=0)
const BURST_WINDOW_MS = 10_000;
const BURST_THRESHOLD = 3;

const VOLUME_WINDOW_MS = 300_000; // 5 min
const VOLUME_THRESHOLD = 10;

const PUNISH_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

// URL audit (funciona mesmo se a UI te mandar pra /communities)
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

// axios roblox (kick)
let csrfToken = null;
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0"
  },
  validateStatus: () => true
});

// estado
let running = false;
let lastImgHash = "";
let lastEventKeys = new Set();        // dedupe de eventos (actor|acao|quando)
const actorTimes = new Map();         // actor -> timestamps
const punishedUntil = new Map();      // actor -> cooldownUntil

// browser reuso
let browser = null;
let context = null;
let page = null;

/* ================= DISCORD ================= */
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

/* ================= ROBLOX AUTH/CSRF ================= */
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
/* ========================================= */

/* ================= RESOLVER USERID ================= */
// 1) tenta por username (preciso)
async function usernameToUserId(username) {
  const res = await axios.post(
    "https://users.roblox.com/v1/usernames/users",
    { usernames: [username], excludeBannedUsers: false },
    { headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` }, validateStatus: () => true }
  );
  const id = res?.data?.data?.[0]?.id;
  return typeof id === "number" ? id : null;
}

// 2) fallback: search (pra quando OCR pegar display name)
async function searchNameToUserId(name) {
  const res = await axios.get(
    `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(name)}&limit=10`,
    { headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` }, validateStatus: () => true }
  );

  const data = res?.data?.data || [];
  const lower = String(name).toLowerCase();

  // tenta match exato em "name" ou "displayName"
  const exact = data.find(u =>
    String(u?.name || "").toLowerCase() === lower ||
    String(u?.displayName || "").toLowerCase() === lower
  );
  if (exact?.id) return exact.id;

  // senão pega o primeiro (melhor que nada)
  return data?.[0]?.id ?? null;
}

async function resolveUserId(actorText) {
  let id = await usernameToUserId(actorText);
  if (id) return id;
  id = await searchNameToUserId(actorText);
  return id || null;
}
/* ========================================= */

/* ================= KICK ================= */
async function kickFromGroup(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);

  // se CSRF expirou, tenta renovar e repetir
  if (res.status === 403 || res.status === 400) {
    await refreshCSRF();
    res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);
  }

  if (res.status < 200 || res.status >= 300) {
    // guarda resposta pra debug
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    throw new Error(`Falha ao exilar (HTTP ${res.status}) ${body?.slice(0, 180) || ""}`);
  }
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
  if (status !== 200) throw new Error("Cookie não logou no navegador (inválido/expirado).");

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
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "audit.png" });
}
/* ========================================= */

/* ================= OCR (OpenAI) ================= */
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
`Você está vendo um Audit Log de comunidade/grupo Roblox.

Extraia SOMENTE eventos de aprovação/recusa de pedidos de entrada.
Retorne UMA linha por evento no formato:

ATOR | ACAO | QUANDO

- ACAO deve ser apenas: aceitou ou recusou
- QUANDO é o texto de tempo visível na linha (ex: "00:51" / "1 min" / "há 2 minutos" etc). Se não existir, use "sem_tempo".

Exemplos:
cami_hudson | aceitou | 00:51
moderadorX | recusou | 1 min

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
      const parts = l.split("|").map(x => x.trim());
      const actor = parts[0] || "";
      const action = (parts[1] || "").toLowerCase();
      const when = parts[2] || "sem_tempo";
      return { actor, action, when };
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

  return actorTimes.get(actor);
}

function shouldPunish(actor) {
  if (TEST_MODE) return true;

  const t = now();
  const arr = actorTimes.get(actor) || [];
  const burst = arr.filter(x => x >= t - BURST_WINDOW_MS).length;
  const vol = arr.filter(x => x >= t - VOLUME_WINDOW_MS).length;

  return burst >= BURST_THRESHOLD || vol >= VOLUME_THRESHOLD;
}

function canPunish(actor) {
  return (punishedUntil.get(actor) || 0) <= now();
}

function markPunished(actor) {
  punishedUntil.set(actor, now() + PUNISH_COOLDOWN_MS);
}
/* ========================================= */

/* ================= PUNIR ================= */
async function punishActor(actor) {
  if (!canPunish(actor)) return;

  // manda SEMPRE o relatório no formato exato
  await sendDiscord(formatRelatorioExilio(actor));

  try {
    const userId = await resolveUserId(actor);
    if (!userId) throw new Error("Não consegui resolver userId (username/displayName).");

    await kickFromGroup(userId);
  } catch (e) {
    // manda debug em outra msg (pra não quebrar seu formato)
    await sendDiscord(
      `⚠️ Exílio automático falhou para **${actor}**.\n` +
      `Motivo provável: permissão da conta do cookie / actor veio como display name / user não é membro.\n` +
      `Erro: ${String(e?.message || e).slice(0, 500)}`
    );
  }

  markPunished(actor);
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

    // dedupe por chave "actor|action|when"
    const currentKeys = new Set(events.map(e => `${e.actor}|${e.action}|${e.when}`));
    const newKeys = [...currentKeys].filter(k => !lastEventKeys.has(k));
    lastEventKeys = currentKeys;

    if (!newKeys.length) return;

    for (const k of newKeys) {
      const [actor, action] = k.split("|").map(x => x.trim());
      recordActor(actor);

      // tanto aceitou quanto recusou contam como spam/all
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
  const me = await validarCookieHTTP();
  if (!me) {
    await sendDiscord("❌ ROBLOSECURITY inválido/expirado. Atualize o cookie.");
    process.exit(1);
  }

  await refreshCSRF();
  await initBrowser();

  console.log(`🛡️ Anti Accept/Recuse-all ATIVO | TEST_MODE=${TEST_MODE} | INTERVALO=${INTERVALO}ms`);
  setInterval(monitorar, INTERVALO);
})();
