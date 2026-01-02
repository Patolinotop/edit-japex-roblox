import { firefox } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";
import FormData from "form-data";
import { execSync } from "child_process";
import dns from "dns";

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
let COOKIE = process.env.ROBLOSECURITY;

const WEBHOOK_EXILIO = process.env.DISCORD_WEBHOOK_EXILIO;
const WEBHOOK_REBAIXO = process.env.DISCORD_WEBHOOK_REBAIXAMENTO;

let OPENAI_KEY = process.env.OPENAI_API_KEY;

const DISCORD_RESPONSAVEL_ID = "1455692969322614895";

// Intervalo default: 5 min
const INTERVALO = Number(process.env.INTERVALO_MS || "300000");

// Test mode (padrão OFF)
const TEST_MODE = String(process.env.TEST_MODE || "0") === "1";

// Regra: 3+ ações no mesmo minuto pelo mesmo usuário => punição
const SAME_MINUTE_THRESHOLD = Number(process.env.SAME_MINUTE_THRESHOLD || "3");

// Cooldown pra não punir em loop
const PUNISH_COOLDOWN_MS = 30 * 60 * 1000;

// URL audit
const AUDIT_URL = `https://www.roblox.com/groups/configure?id=${GROUP_ID}#!/auditLog`;

// Modelo de visão
const VISION_MODEL = process.env.VISION_MODEL || "gpt-4.1";

// Robustez
const CAPTURE_RETRIES = Number(process.env.CAPTURE_RETRIES || "3");
const OCR_RETRIES = Number(process.env.OCR_RETRIES || "3");
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || "2500");
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || "60000");
const SHORT_WAIT_MS = Number(process.env.SHORT_WAIT_MS || "1200");

// OpenAI timeouts
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || "60000");
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || "0");

// IPv4 opcional
const FORCE_IPV4 = String(process.env.FORCE_IPV4 || "0") === "1";

// ✅ nomes exatos (como na print)
const CABO_ROLE_NAME = String(process.env.CABO_ROLE_NAME || "[Cb] Cabo");
const THIRD_SGT_ROLE_NAME = String(process.env.THIRD_SGT_ROLE_NAME || "[3ºSgt] Terceiro Sargento");
/* ========================================= */

if (FORCE_IPV4) {
  try {
    dns.setDefaultResultOrder("ipv4first");
    console.log("🌐 FORCE_IPV4=1 => DNS ipv4first habilitado.");
  } catch {}
}

/* ================= SANITIZERS ================= */
function stripOuterQuotes(s) {
  const t = String(s || "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function sanitizeApiKey(key) {
  let k = stripOuterQuotes(key);
  k = k.replace(/^Bearer\s+/i, "");
  k = k.replace(/[\r\n\t]/g, "");
  k = k.replace(/\s+/g, "").trim();
  return k;
}

function redactSecrets(s) {
  const str = String(s || "");
  return str.replace(/sk-(proj-)?[A-Za-z0-9_\-]{10,}/g, "sk-***REDACTED***");
}

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
/* ============================================ */

OPENAI_KEY = sanitizeApiKey(OPENAI_KEY);
COOKIE = stripOuterQuotes(String(COOKIE || "").trim());

if (COOKIE.startsWith(".ROBLOSECURITY=")) {
  COOKIE = COOKIE.replace(".ROBLOSECURITY=", "").trim();
}

if (!GROUP_ID || !COOKIE || !OPENAI_KEY || !WEBHOOK_EXILIO || !WEBHOOK_REBAIXO) {
  console.error("❌ Faltando env:");
  console.error("  - GROUP_ID");
  console.error("  - ROBLOSECURITY");
  console.error("  - OPENAI_API_KEY");
  console.error("  - DISCORD_WEBHOOK_EXILIO");
  console.error("  - DISCORD_WEBHOOK_REBAIXAMENTO");
  process.exit(1);
}

// OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  timeout: OCR_TIMEOUT_MS,
  maxRetries: OPENAI_MAX_RETRIES
});

/* ================= HELPERS ================= */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sha256File(filepath) {
  const buf = fs.readFileSync(filepath);
  return crypto.createHash("sha256").update(buf).digest("hex");
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

function normalizeMinuteKey(whenRaw) {
  const w = String(whenRaw || "").trim();
  const hm = w.match(/(\d{1,2}:\d{2})/);
  return hm ? hm[1] : "unknown";
}

function isLikelyUsername(s) {
  const t = String(s || "").trim().replace(/^@/, "");
  return /^[a-zA-Z0-9_]{3,20}$/.test(t);
}

function formatOpenAIError(err) {
  try {
    const isApiErr = err instanceof OpenAI.APIError;
    const base = {
      name: err?.name,
      message: redactSecrets(err?.message),
      status: isApiErr ? err.status : undefined,
      code: isApiErr ? err.code : undefined,
      request_id: isApiErr ? err.request_id : undefined
    };
    const cause = err?.cause;
    if (cause) {
      base.cause = {
        name: cause?.name,
        message: redactSecrets(cause?.message),
        code: cause?.code,
        errno: cause?.errno,
        syscall: cause?.syscall
      };
    }
    return JSON.stringify(base);
  } catch {
    return redactSecrets(String(err?.message || err));
  }
}

function hojeBR() {
  return new Date().toLocaleDateString("pt-BR");
}
/* ========================================= */

/* ================= DISCORD ================= */
async function sendDiscord(webhookUrl, content, imagePath = null) {
  try {
    if (!imagePath) {
      await axios.post(webhookUrl, { content });
      return;
    }

    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content }));
    form.append("file", fs.createReadStream(imagePath), { filename: "auditoria.png" });

    const res = await axios.post(webhookUrl, form, {
      headers: form.getHeaders(),
      validateStatus: () => true
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers["retry-after"]) || 1;
      await sleep(retryAfter * 1000);
      await axios.post(webhookUrl, form, {
        headers: form.getHeaders(),
        validateStatus: () => true
      });
    }
  } catch (e) {
    console.error("⚠️ Discord falhou:", String(e?.message || e));
  }
}

function formatRelatorioExilio(usernameSemArroba) {
  const data = hojeBR();
  return (
`***Relatório de Exílio!

Responsável: <@${DISCORD_RESPONSAVEL_ID}>

Exilado(a): ${usernameSemArroba}

Motivo: Aceppt-all

Data: ${data}***`
  );
}

function formatRelatorioRebaixamento(usernameSemArroba, patenteAntiga, patenteNova) {
  const data = hojeBR();
  return (
`***Relatório de Rebaixamento!

Responsável: <@${DISCORD_RESPONSAVEL_ID}>

Rebaixado(a): ${usernameSemArroba}

Patente antiga: ${patenteAntiga}
Patente nova: ${patenteNova}

Data: ${data}***`
  );
}
/* ========================================= */

/* ================= STATE ================= */
let running = false;
let baselineReady = false;

let lastImgHash = "";

// ✅ agora é MULTISET: key -> count
let lastEventCounts = new Map();

const punishedUntil = new Map();     // actorKey -> cooldownUntil
const actorMinuteCounts = new Map(); // actorKey -> Map(minuteKey -> count)

// cache de roles do grupo
let rolesCache = null;
let rolesCacheAt = 0;
const ROLES_CACHE_MS = 10 * 60 * 1000;
/* ========================================= */

/* ================= PLAYWRIGHT SETUP ================= */
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

async function ensureEntryRequestFilter() {
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

// captura robusta
async function capturarAuditRobusto() {
  if (!page || page.isClosed()) await initBrowser();

  for (let attempt = 1; attempt <= CAPTURE_RETRIES; attempt++) {
    try {
      console.log(`📸 Captura tentativa ${attempt}/${CAPTURE_RETRIES}...`);

      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      } catch {
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
      try { await closeSilently(); } catch {}
      await sleep(RETRY_DELAY_MS);
      await initBrowser();
    }
  }

  throw new Error("Falha geral: não consegui capturar a auditoria após retries.");
}
/* ========================================= */

/* ================= OCR ================= */
async function ocrAuditEvents() {
  const base64 = fs.readFileSync("audit_last.png").toString("base64");

  for (let attempt = 1; attempt <= OCR_RETRIES; attempt++) {
    try {
      console.log(`🧠 OCR tentativa ${attempt}/${OCR_RETRIES}...`);

      const resp = await openai.responses.create(
        {
          model: VISION_MODEL,
          temperature: 0,
          max_output_tokens: 500,
          input: [{
            role: "user",
            content: [
              {
                type: "input_text",
                text:
`Você está vendo uma TABELA do Roblox "Atividade do grupo" com colunas: Data | Usuário | Descrição.

OBJETIVO:
Extrair SOMENTE eventos de PEDIDO DE ENTRADA (aceitou/recusou), mas o NOME que importa é SEMPRE QUEM FEZ A AÇÃO (coluna "Usuário").

REGRAS IMPORTANTES:
1) O "Usuário" (coluna do meio) é o ATOR: quem aceitou/recusou.
2) Na "Descrição" aparece "do usuário <ALVO>". Esse <ALVO> NUNCA é o ator. NÃO use esse nome.
3) O ator deve vir da coluna "Usuário".
   - Se existir um @handle abaixo do nome (ex: @camillygamer_01), use ELE (sem @).
   - Se não existir, use o nome de exibição da coluna.

Filtrar SOMENTE descrições que contenham:
- "aceitou o pedido de entrada"
- "recusou o pedido de entrada"

FORMATO DE SAÍDA (uma linha por evento, NÃO agrupe):
ATOR | ACAO | QUANDO

- ATOR: do campo "Usuário" (sem @)
- ACAO: "aceitou" ou "recusou"
- QUANDO: pegue o horário HH:MM visível em "Data"

Se não houver eventos, responda exatamente:
SEM ALTERACOES`
              },
              { type: "input_image", image_url: `data:image/png;base64,${base64}` }
            ]
          }]
        },
        { timeout: OCR_TIMEOUT_MS, maxRetries: 0 }
      );

      const text = (resp.output_text || "").trim();
      console.log("✅ OCR retornou:", text ? text.slice(0, 180) : "(vazio)");

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
    } catch (e) {
      console.error(`⚠️ OCR falhou (tentativa ${attempt}):`, formatOpenAIError(e));
      const backoff = Math.min(1500 * attempt, 8000);
      await sleep(backoff);
    }
  }

  console.error("❌ OCR falhou em todas as tentativas. Pulando este ciclo.");
  return [];
}
/* ========================================= */

/* ================= ROBLOX RESOLVE USER ================= */
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

/* ================= GROUP ROLES (para rebaixar) ================= */
async function getGroupRolesCached() {
  const t = Date.now();
  if (rolesCache && (t - rolesCacheAt) < ROLES_CACHE_MS) return rolesCache;

  const res = await api.get(`https://groups.roblox.com/v1/groups/${GROUP_ID}/roles`);
  if (!res.ok()) throw new Error(`Falha roles group: HTTP ${res.status()}`);

  const body = await res.json();
  const roles = body?.roles || [];

  const cleaned = roles
    .map(r => ({ id: r.id, name: r.name, rank: r.rank }))
    .filter(r => typeof r.id === "number" && typeof r.rank === "number");

  cleaned.sort((a, b) => a.rank - b.rank);

  rolesCache = cleaned;
  rolesCacheAt = t;
  return rolesCache;
}

function findRoleByExactName(roles, exactName) {
  const target = norm(exactName);
  return roles.find(r => norm(r.name) === target) || null;
}

async function getUserRoleInGroup(userId) {
  const res = await api.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
  if (!res.ok()) return null;
  const body = await res.json();
  const data = body?.data || [];

  const entry = data.find(g => String(g?.group?.id) === String(GROUP_ID));
  if (!entry) return null;

  const role = entry?.role;
  if (!role) return null;

  return {
    roleId: role.id,
    roleName: role.name,
    roleRank: role.rank
  };
}

async function setUserRole(userId, newRoleId) {
  if (!csrfToken) await refreshCSRF();

  let res = await api.patch(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`, {
    headers: { "x-csrf-token": csrfToken },
    data: { roleId: newRoleId }
  });

  if (res.status() === 403) {
    await refreshCSRF();
    res = await api.patch(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { roleId: newRoleId }
    });
  }

  if (res.status() === 401) throw new Error("HTTP 401 (cookie inválido/expirou).");

  if (res.status() < 200 || res.status() >= 300) {
    let body = "";
    try { body = JSON.stringify(await res.json()).slice(0, 260); } catch {}
    throw new Error(`PATCH role HTTP ${res.status()} ${body}`);
  }
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

/* ================= MULTISET DIFF (NOVO) ================= */
function makeEventKey(e) {
  return `${e.name}|${e.action}|${e.when}`;
}

function buildCounts(events) {
  const m = new Map();
  for (const e of events) {
    const k = makeEventKey(e);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

// retorna lista de { key, times } onde times = ocorrências novas
function diffCounts(prev, cur) {
  const out = [];
  for (const [k, curN] of cur.entries()) {
    const prevN = prev.get(k) || 0;
    const delta = curN - prevN;
    if (delta > 0) out.push({ key: k, times: delta });
  }
  return out;
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

/* ================= PUNIÇÃO (REBAIXA OU EXILA) ================= */
async function punishActor(actorKey) {
  if (!canPunish(actorKey)) return;

  const resolved = await resolveUser(actorKey);
  if (!resolved) {
    console.error(`⚠️ Não consegui resolver usuário a partir de "${actorKey}".`);
    markPunished(actorKey);
    return;
  }

  const { userId, usernameForReport } = resolved;

  const userRole = await getUserRoleInGroup(userId);
  if (!userRole) {
    console.error(`⚠️ Usuário ${usernameForReport} não está no grupo ou falha ao ler role.`);
    markPunished(actorKey);
    return;
  }

  const roles = await getGroupRolesCached();

  const cabo = findRoleByExactName(roles, CABO_ROLE_NAME);
  const third = findRoleByExactName(roles, THIRD_SGT_ROLE_NAME);

  if (!cabo || !third) {
    console.error("❌ Não achei roles de referência (Cabo / Terceiro Sargento).");
    console.error("   Verifique CABO_ROLE_NAME e THIRD_SGT_ROLE_NAME nas envs.");
    markPunished(actorKey);
    return;
  }

  const { roleName, roleRank } = userRole;

  try {
    // third ou acima => rebaixa 1
    if (roleRank >= third.rank) {
      const below = roles.filter(r => r.rank < roleRank).sort((a, b) => b.rank - a.rank)[0] || null;
      if (!below) {
        console.error(`⚠️ Não achei role abaixo de ${roleName} para rebaixar.`);
        markPunished(actorKey);
        return;
      }

      const targetRole = (below.rank < cabo.rank) ? cabo : below;

      if (!TEST_MODE) {
        await setUserRole(userId, targetRole.id);
      }

      console.log(`✅ Rebaixamento OK: ${usernameForReport} | ${roleName} -> ${targetRole.name}`);

      markPunished(actorKey);
      await sendDiscord(
        WEBHOOK_REBAIXO,
        formatRelatorioRebaixamento(usernameForReport, roleName, targetRole.name),
        "audit_last.png"
      );
      return;
    }

    // cabo ou abaixo => exila
    if (!TEST_MODE) {
      await kickFromGroup(userId);
    }

    console.log(`✅ Exílio OK: ${usernameForReport} (rank=${roleRank}, role=${roleName})`);

    markPunished(actorKey);
    await sendDiscord(WEBHOOK_EXILIO, formatRelatorioExilio(usernameForReport), "audit_last.png");
  } catch (e) {
    console.error(`⚠️ Falha punição de ${usernameForReport}:`, String(e?.message || e));
    markPunished(actorKey);
  }
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

    // baseline (sem punir)
    if (!baselineReady) {
      lastEventCounts = buildCounts(events);
      baselineReady = true;
      console.log("✅ Baseline setado (OCR feito com sucesso).");
      return;
    }

    if (!events.length) {
      console.log("ℹ️ OCR: SEM ALTERACOES (pedido de entrada).");
      return;
    }

    // ✅ agora conta ocorrências novas, inclusive repetidas no mesmo minuto
    const currentCounts = buildCounts(events);
    const news = diffCounts(lastEventCounts, currentCounts);
    lastEventCounts = currentCounts;

    if (!news.length) {
      console.log("ℹ️ Nenhum evento novo (diferença já vista).");
      return;
    }

    for (const item of news) {
      const [name, action, when] = item.key.split("|").map(x => x.trim());
      const actorKey = name.replace(/^@/, "").trim();
      const minuteKey = normalizeMinuteKey(when);

      // processa "times" ocorrências novas
      for (let i = 0; i < item.times; i++) {
        const minuteCount = recordMinute(actorKey, minuteKey);

        console.log(
          `📌 Evento pedido-entrada: ${actorKey} ${action} | minuto="${minuteKey}" | countMin=${minuteCount} (occ ${i + 1}/${item.times})`
        );

        if (shouldPunish(minuteCount)) {
          await punishActor(actorKey);
        }
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
  console.log(`✅ Regra: >=${SAME_MINUTE_THRESHOLD} ações (aceitar/recusar pedido de entrada) no mesmo minuto => punição.`);
  console.log("ℹ️ Primeira execução faz baseline.");

  await monitorar(); // baseline
  setInterval(monitorar, INTERVALO);
})();
