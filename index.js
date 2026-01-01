import { firefox } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";
import FormData from "form-data";
import { execSync } from "child_process";

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
let COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const DISCORD_RESPONSAVEL_ID = "1455692969322614895";

const INTERVALO = Number(process.env.INTERVALO_MS || "300000"); // 5 min default
const TEST_MODE = String(process.env.TEST_MODE || "0") === "1";

// Regra: 3+ ações (aceitou/recusou) no MESMO minuto pelo mesmo cara => exílio
const SAME_MINUTE_THRESHOLD = Number(process.env.SAME_MINUTE_THRESHOLD || "3");

const PUNISH_COOLDOWN_MS = 30 * 60 * 1000;

const AUDIT_URL = `https://www.roblox.com/groups/configure?id=${GROUP_ID}#!/auditLog`;

// Modelo mais “carinho”, sem raciocínio pesado
const VISION_MODEL = process.env.VISION_MODEL || "gpt-4.1";
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

/* ================= DISCORD (com anexo) ================= */
async function sendDiscord(content, imagePath = null) {
  try {
    if (!imagePath) {
      await axios.post(WEBHOOK, { content });
      return;
    }

    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content }));
    form.append("file", fs.createReadStream(imagePath), { filename: "auditoria.png" });

    const res = await axios.post(WEBHOOK, form, { headers: form.getHeaders(), validateStatus: () => true });

    // retry simples se rate-limit
    if (res.status === 429) {
      const retryAfter = Number(res.headers["retry-after"]) || 1;
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      await axios.post(WEBHOOK, form, { headers: form.getHeaders(), validateStatus: () => true });
    }
  } catch (e) {
    console.error("⚠️ Discord falhou:", String(e?.message || e));
  }
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
let baselineReady = false;

let lastImgHash = "";
let lastEventKeys = new Set();

const punishedUntil = new Map();         // actorKey -> cooldownUntil
const actorMinuteCounts = new Map();     // actorKey -> Map(minuteKey -> count)
/* ========================================= */

/* ================= PLAYWRIGHT FALLBACK ================= */
function ensurePlaywrightBrowsersInstalled() {
  try {
    console.log("🔧 Instalando browsers do Playwright (firefox)...");
    execSync("npx playwright install firefox", { stdio: "inherit" });
  } catch (e) {
    console.error("❌ Falha ao instalar browsers do Playwright.");
    console.error(String(e?.message || e));
    process.exit(1);
  }
}
/* ========================================= */

/* ================= PLAYWRIGHT + API ================= */
let browser = null;
let context = null;
let page = null;
let api = null;
let csrfToken = null;

async function closeSilently() {
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  browser = null; context = null; page = null; api = null; csrfToken = null;
}

async function refreshCSRF() {
  const res = await api.post("https://auth.roblox.com/v2/logout");
  const token = res.headers()["x-csrf-token"];
  if (!token) throw new Error("Não consegui obter X-CSRF-TOKEN.");
  csrfToken = token;
}

async function authStatus() {
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
      ensurePlaywrightBrowsersInstalled();
      browser = await firefox.launch({ headless: true });
    } else {
      throw e;
    }
  }

  context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
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
  await page.waitForTimeout(1000);

  const s = await authStatus();
  if (s !== 200) throw new Error(`ROBLOSECURITY inválido/expirado (status ${s}).`);

  await refreshCSRF();

  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);

  // tenta aplicar filtro da UI (se falhar, ok)
  await ensureEntryRequestFilter();
}

// tenta deixar a aba/filtro em "Aceitar pedido de entrada"
async function ensureEntryRequestFilter() {
  try {
    // 1) tenta achar algo clicável com "Tudo"
    const tudo = page.getByText("Tudo", { exact: true }).first();
    if (await tudo.count()) {
      await tudo.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // 2) tenta clicar na opção "Aceitar pedido de entrada"
    // (às vezes aparece como menu/combobox)
    const opt = page.getByText("Aceitar pedido de entrada", { exact: false }).first();
    if (await opt.count()) {
      await opt.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  } catch {
    // silêncio: filtro pode variar, OCR já filtra por texto
  }
}

// só mantém 2 prints: prev e last
function rotateScreenshots() {
  try {
    if (fs.existsSync("audit_last.png")) {
      try { fs.unlinkSync("audit_prev.png"); } catch {}
      fs.renameSync("audit_last.png", "audit_prev.png");
    }
    fs.renameSync("audit_new.png", "audit_last.png");
  } catch (e) {
    console.error("⚠️ Falha rotacionando prints:", String(e?.message || e));
  }
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
  await ensureEntryRequestFilter(); // garante filtro sempre que der
  await page.waitForTimeout(500);

  await page.screenshot({ path: "audit_new.png" });
  rotateScreenshots();
}
/* ========================================= */

/* ================= OCR (filtro forte) ================= */
function isLikelyUsername(s) {
  const t = String(s || "").trim().replace(/^@/, "");
  return /^[a-zA-Z0-9_]{3,20}$/.test(t);
}

function normalizeMinuteKey(whenRaw) {
  const w = String(whenRaw || "").trim();
  const hm = w.match(/(\d{1,2}:\d{2})/);
  return hm ? hm[1] : "unknown";
}

async function ocrAuditEvents() {
  const base64 = fs.readFileSync("audit_last.png").toString("base64");

  const resp = await openai.responses.create({
    model: VISION_MODEL,
    max_output_tokens: 220,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text:
`Você está vendo a página "Atividade do grupo" (audit log) do Roblox.

TAREFA: Extraia SOMENTE eventos de PEDIDO DE ENTRADA.
- Aceitar pedido de entrada
- Recusar pedido de entrada

IGNORE COMPLETAMENTE:
- mudança de cargo
- remoção/ban
- qualquer outra ação

Se o evento NÃO contiver explicitamente a expressão "pedido de entrada" na descrição, NÃO inclua.

Retorne UMA linha por evento no formato:
NOME | ACAO | QUANDO

Regras:
- NOME: use o @username (sem "@") se estiver visível. Se só tiver display name, retorne o display name mesmo assim.
- ACAO: "aceitou" ou "recusou"
- QUANDO: copie o tempo visível (precisa conter HH:MM se aparecer)

Se não houver eventos de pedido de entrada visíveis, responda exatamente:
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
      const [nameRaw, actionRaw, whenRaw] = l.split("|").map(x => x.trim());
      const name = (nameRaw || "").replace(/^@/g, "").trim();
      const action = (actionRaw || "").toLowerCase();
      const when = whenRaw || "sem_tempo";
      return { name, action, when, minuteKey: normalizeMinuteKey(whenRaw) };
    })
    .filter(e => e.name && (e.action === "aceitou" || e.action === "recusou"));
}
/* ========================================= */

/* ================= RESOLVE USER ================= */
async function usernameToUserId(username) {
  const res = await api.post("https://users.roblox.com/v1/usernames/users", {
    data: { usernames: [username], excludeBannedUsers: false }
  });
  if (!res.ok()) return null;
  const body = await res.json();
  const id = body?.data?.[0]?.id;
  return typeof id === "number" ? id : null;
}

async function resolveByDisplayName(displayName) {
  const res = await api.get(
    `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(displayName)}&limit=10`
  );
  if (!res.ok()) return null;

  const body = await res.json();
  const list = body?.data || [];
  const lower = String(displayName).toLowerCase();

  const exact = list.find(u => String(u?.displayName || "").toLowerCase() === lower);
  const pick = exact || list[0];
  if (!pick?.id) return null;

  return { userId: pick.id, username: pick.name || null };
}

async function resolveUser(nameFromOCR) {
  const n = String(nameFromOCR || "").trim();

  if (isLikelyUsername(n)) {
    const userId = await usernameToUserId(n);
    if (!userId) return null;
    return { userId, usernameForReport: n };
  }

  const byDisp = await resolveByDisplayName(n);
  if (!byDisp?.userId) return null;

  return {
    userId: byDisp.userId,
    usernameForReport: (byDisp.username || n).replace(/^@/, "")
  };
}
/* ========================================= */

/* ================= KICK ================= */
async function kickFromGroup(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await api.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`, {
    headers: { "x-csrf-token": csrfToken }
  });

  if (res.status() === 403) {
    await refreshCSRF();
    res = await api.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`, {
      headers: { "x-csrf-token": csrfToken }
    });
  }

  if (res.status() === 401) throw new Error("HTTP 401 (cookie inválido/expirou).");

  if (res.status() < 200 || res.status() >= 300) {
    let body = "";
    try { body = JSON.stringify(await res.json()).slice(0, 260); } catch {}
    throw new Error(`HTTP ${res.status()} ${body}`);
  }
}
/* ========================================= */

/* ================= DETECÇÃO ================= */
function now() { return Date.now(); }

function canPunish(key) {
  return (punishedUntil.get(key) || 0) <= now();
}

function markPunished(key) {
  punishedUntil.set(key, now() + PUNISH_COOLDOWN_MS);
}

function recordMinute(actorKey, minuteKey) {
  if (!actorMinuteCounts.has(actorKey)) actorMinuteCounts.set(actorKey, new Map());
  const m = actorMinuteCounts.get(actorKey);

  const cur = (m.get(minuteKey) || 0) + 1;
  m.set(minuteKey, cur);

  // mantém poucos minutos por actor
  if (m.size > 8) {
    const keys = [...m.keys()];
    for (let i = 0; i < keys.length - 8; i++) m.delete(keys[i]);
  }

  return cur;
}

function shouldPunish(minuteCount) {
  if (TEST_MODE) return true;
  return minuteCount >= SAME_MINUTE_THRESHOLD;
}
/* ========================================= */

/* ================= PUNIÇÃO ================= */
async function punishActor(actorKey) {
  if (!canPunish(actorKey)) return;

  const resolved = await resolveUser(actorKey);
  if (!resolved) {
    console.error(`⚠️ Não consegui resolver usuário a partir de "${actorKey}".`);
    markPunished(actorKey);
    return;
  }

  const { userId, usernameForReport } = resolved;

  // 1) kick
  try {
    await kickFromGroup(userId);
    console.log(`✅ Kick OK: ${usernameForReport} (id=${userId})`);
  } catch (e) {
    console.error(`⚠️ Falha no kick de ${usernameForReport} (id=${userId}):`, String(e?.message || e));
    markPunished(actorKey);
    return;
  }

  // 2) cooldown
  markPunished(actorKey);

  // 3) relatório + print (audit_last.png)
  await sendDiscord(formatRelatorioExilio(usernameForReport), "audit_last.png");
}
/* ========================================= */

/* ================= LOOP ================= */
async function monitorar() {
  if (running) return;
  running = true;

  try {
    await capturarAudit();

    const h = sha256File("audit_last.png");
    if (h === lastImgHash) return;
    lastImgHash = h;

    const events = await ocrAuditEvents();

    // baseline
    if (!baselineReady) {
      lastEventKeys = new Set(events.map(e => `${e.name}|${e.action}|${e.when}`));
      baselineReady = true;
      console.log("✅ Baseline setado. Próximas mudanças serão avaliadas.");
      return;
    }

    if (!events.length) return;

    const currentKeys = new Set(events.map(e => `${e.name}|${e.action}|${e.when}`));
    const newKeys = [...currentKeys].filter(k => !lastEventKeys.has(k));
    lastEventKeys = currentKeys;

    if (!newKeys.length) return;

    for (const k of newKeys) {
      const [name, action, when] = k.split("|").map(x => x.trim());
      const actorKey = name.replace(/^@/, "").trim();
      const minuteKey = normalizeMinuteKey(when);

      const minuteCount = recordMinute(actorKey, minuteKey);

      console.log(`📌 Evento pedido-entrada: ${actorKey} ${action} | minuto="${minuteKey}" | countMin=${minuteCount}`);

      if (shouldPunish(minuteCount)) {
        await punishActor(actorKey);
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
  console.log(`🛡️ Rodando | MODEL=${VISION_MODEL} | TEST_MODE=${TEST_MODE} | INTERVALO=${INTERVALO}ms`);
  console.log(`✅ Regra: >=${SAME_MINUTE_THRESHOLD} ações (aceitar/recusar pedido de entrada) no mesmo minuto => exílio.`);
  console.log("ℹ️ Primeira captura = baseline (não pune ninguém).");

  await monitorar(); // baseline
  setInterval(monitorar, INTERVALO);
})();
