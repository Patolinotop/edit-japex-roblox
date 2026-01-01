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

const INTERVALO = Number(process.env.INTERVALO_MS || "300000"); // 5 min
const TEST_MODE = String(process.env.TEST_MODE || "0") === "1";
const SAME_MINUTE_THRESHOLD = Number(process.env.SAME_MINUTE_THRESHOLD || "3");

const PUNISH_COOLDOWN_MS = 30 * 60 * 1000;

const AUDIT_URL = `https://www.roblox.com/groups/configure?id=${GROUP_ID}#!/auditLog`;

// Modelo “mais carinho” sem raciocínio pesado
const VISION_MODEL = process.env.VISION_MODEL || "gpt-4.1";

// Robustez / retry
const CAPTURE_RETRIES = Number(process.env.CAPTURE_RETRIES || "3");
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || "2500");
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || "60000");
const SHORT_WAIT_MS = Number(process.env.SHORT_WAIT_MS || "1200");
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

/* ================= DISCORD (com print opcional) ================= */
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

const punishedUntil = new Map();
const actorMinuteCounts = new Map();
/* ========================================= */

/* ================= PLAYWRIGHT ================= */
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
  context.setDefaultTimeout(NAV_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

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
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  console.log("🌐 Abrindo Roblox (home)...");
  await page.goto("https://www.roblox.com/home", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(SHORT_WAIT_MS);

  const s = await authStatus();
  if (s !== 200) throw new Error(`ROBLOSECURITY inválido/expirado (status ${s}).`);

  await refreshCSRF();

  console.log("🌐 Abrindo Audit Log...");
  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(SHORT_WAIT_MS);

  await ensureEntryRequestFilter();
}

async function ensureEntryRequestFilter() {
  // Melhor esforço: se não achar, OCR já filtra por “pedido de entrada”
  try {
    const tudo = page.getByText("Tudo", { exact: true }).first();
    if (await tudo.count()) {
      await tudo.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    const opt = page.getByText("Aceitar pedido de entrada", { exact: false }).first();
    if (await opt.count()) {
      await opt.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(350);
    }
  } catch {}
}

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

// ✅ captura com retry + fallback (reload -> goto)
async function capturarAuditRobusto() {
  if (!page || page.isClosed()) await initBrowser();

  for (let attempt = 1; attempt <= CAPTURE_RETRIES; attempt++) {
    try {
      console.log(`📸 Captura tentativa ${attempt}/${CAPTURE_RETRIES}...`);

      // tenta reload
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      } catch {
        // fallback goto
        await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      }

      await page.waitForTimeout(SHORT_WAIT_MS);
      await ensureEntryRequestFilter();
      await page.waitForTimeout(450);

      await page.screenshot({ path: "audit_new.png" });
      rotateScreenshots();

      console.log("✅ Screenshot OK (audit_last.png).");
      return;
    } catch (e) {
      console.error(`⚠️ Falha captura (tentativa ${attempt}):`, String(e?.message || e));

      // reinicia o browser e tenta de novo na mesma execução
      try { await closeSilently(); } catch {}
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      await initBrowser();
    }
  }

  throw new Error("Falha geral: não consegui capturar a auditoria após retries.");
}
/* ========================================= */

/* ================= OCR (FILTRO FORTE) ================= */
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

  console.log("🧠 Enviando imagem para OpenAI OCR...");
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

Extraia SOMENTE eventos de PEDIDO DE ENTRADA:
- "aceitou o pedido de entrada"
- "recusou o pedido de entrada"

IGNORE COMPLETAMENTE:
- mudança de cargo
- remoção/ban
- qualquer outra ação

Só inclua se tiver explicitamente "pedido de entrada" na descrição.

Formato (1 linha por evento):
NOME | ACAO | QUANDO

- NOME: use @username (sem "@") se visível; senão use display name
- ACAO: aceitou ou recusou
- QUANDO: copie o tempo visível (ideal HH:MM)

Se não houver, responda exatamente:
SEM ALTERACOES`
        },
        { type: "input_image", image_url: `data:image/png;base64,${base64}` }
      ]
    }]
  });

  const text = (resp.output_text || "").trim();
  console.log("✅ OCR retornou:", text ? text.slice(0, 120) : "(vazio)");

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

  try {
    await kickFromGroup(userId);
    console.log(`✅ Kick OK: ${usernameForReport} (id=${userId})`);
  } catch (e) {
    console.error(`⚠️ Falha no kick de ${usernameForReport} (id=${userId}):`, String(e?.message || e));
    markPunished(actorKey);
    return;
  }

  markPunished(actorKey);

  // relatório + print
  await sendDiscord(formatRelatorioExilio(usernameForReport), "audit_last.png");
}
/* ========================================= */

/* ================= LOOP ================= */
async function monitorar() {
  if (running) return;
  running = true;

  try {
    await capturarAuditRobusto();

    const h = sha256File("audit_last.png");
    if (h === lastImgHash) {
      console.log("🟰 Screenshot igual (sem mudança visual). Pulando OCR.");
      return;
    }
    lastImgHash = h;

    const events = await ocrAuditEvents();

    // baseline
    if (!baselineReady) {
      lastEventKeys = new Set(events.map(e => `${e.name}|${e.action}|${e.when}`));
      baselineReady = true;
      console.log("✅ Baseline setado (OCR realizado). Próximas mudanças serão avaliadas.");
      return;
    }

    if (!events.length) {
      console.log("ℹ️ OCR: SEM ALTERACOES (pedido de entrada).");
      return;
    }

    const currentKeys = new Set(events.map(e => `${e.name}|${e.action}|${e.when}`));
    const newKeys = [...currentKeys].filter(k => !lastEventKeys.has(k));
    lastEventKeys = currentKeys;

    if (!newKeys.length) {
      console.log("ℹ️ Nenhum evento novo (diferença já vista).");
      return;
    }

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
    // se der erro, reinicia browser pra próxima execução
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
  console.log("ℹ️ Primeira execução faz baseline (e força OCR se conseguir capturar).");

  // baseline imediato (com retry robusto)
  await monitorar();

  setInterval(monitorar, INTERVALO);
})();
