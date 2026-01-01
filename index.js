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

// produção sugerida quando TEST_MODE=0
const BURST_WINDOW_MS = 10_000;
const BURST_THRESHOLD = 3;

const VOLUME_WINDOW_MS = 300_000; // 5 min
const VOLUME_THRESHOLD = 10;

const PUNISH_COOLDOWN_MS = 30 * 60 * 1000;

// evita punir 50x o mesmo cara por OCR variar
const RECENT_PUNISH_TTL_MS = 60 * 60 * 1000; // 1h

const AUDIT_URL = `https://www.roblox.com/groups/configure?id=${GROUP_ID}#!/auditLog`;
/* ========================================= */

if (!GROUP_ID || !COOKIE || !WEBHOOK || !OPENAI_KEY) {
  console.error("❌ Faltando env: GROUP_ID / ROBLOSECURITY / DISCORD_WEBHOOK / OPENAI_API_KEY");
  process.exit(1);
}

// sanitiza cookie (NÃO cole aqui publicamente)
COOKIE = COOKIE.trim();
if ((COOKIE.startsWith('"') && COOKIE.endsWith('"')) || (COOKIE.startsWith("'") && COOKIE.endsWith("'"))) {
  COOKIE = COOKIE.slice(1, -1).trim();
}
if (COOKIE.startsWith(".ROBLOSECURITY=")) {
  COOKIE = COOKIE.replace(".ROBLOSECURITY=", "").trim();
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ================= DISCORD ================= */
async function sendDiscord(content) {
  await axios.post(WEBHOOK, { content });
}

function formatRelatorioExilio(exiladoSemArroba) {
  const data = new Date().toLocaleDateString("pt-BR");
  return (
`***Relatório de Exílio!

Responsável: <@${DISCORD_RESPONSAVEL_ID}>

Exilado(a): ${exiladoSemArroba}

Motivo: Aceppt-all

Data: ${data}***`
  );
}
/* ========================================= */

/* ================= STATE ================= */
let running = false;
let lastImgHash = "";
let lastEventKeys = new Set();
let baselineReady = false;

const actorTimes = new Map();       // actorName -> [timestamps]
const punishedUntil = new Map();    // actorName -> cooldownUntil
const punishedRecently = new Map(); // canonicalName -> timestamp (anti spam)
/* ========================================= */

/* ================= PLAYWRIGHT FALLBACK ================= */
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

/* ================= PLAYWRIGHT + API (cookies do browser) ================= */
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
      console.error("⚠️ Firefox do Playwright não encontrado. Instalando em runtime...");
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

  const s = await authStatus();
  if (s !== 200) throw new Error(`ROBLOSECURITY inválido/expirado (status ${s}).`);

  await refreshCSRF();

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
function cleanName(s) {
  return String(s || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function ocrAuditEvents() {
  const base64 = fs.readFileSync("audit.png").toString("base64");

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: 320,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text:
`Você está vendo o Audit Log de um grupo/comunidade Roblox.

Extraia SOMENTE ações de pedidos de entrada (aceitou/recusou).
Quero o RESPONSÁVEL (quem fez a ação), NÃO quem foi aceito/recusado.

IMPORTANTE:
- Se aparecer Display Name grande e abaixo "@username", use o @username.
- Retorne o nome SEM "@". (ex: cami_hudzinha)
- Se não houver @username visível, retorne o nome que aparecer mesmo.

Formato (1 linha por evento):
RESPONSAVEL | ACAO | QUANDO

- ACAO: aceitou ou recusou
- QUANDO: texto de tempo visível (ou "sem_tempo")

Se não houver alterações visíveis, responda exatamente:
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
      const [whoRaw, actionRaw, whenRaw] = l.split("|").map(x => x.trim());
      const who = cleanName(whoRaw);
      const action = (actionRaw || "").toLowerCase();
      const when = whenRaw || "sem_tempo";
      return { who, action, when };
    })
    .filter(e => e.who && (e.action === "aceitou" || e.action === "recusou"));
}
/* ========================================= */

/* ================= USER RESOLVE (public + fuzzy) ================= */
// Username “puro” costuma ser assim (Roblox):
function looksLikeUsername(s) {
  const t = cleanName(s);
  return /^[a-zA-Z0-9_]{3,20}$/.test(t);
}

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

async function resolveUserIdPublic(nameFromOCR) {
  const name = cleanName(nameFromOCR);
  if (!name) return null;

  // 1) tenta como username (endpoint público, sem cookie)
  if (looksLikeUsername(name)) {
    try {
      const r = await axios.post(
        "https://users.roblox.com/v1/usernames/users",
        { usernames: [name], excludeBannedUsers: false },
        { validateStatus: () => true }
      );

      const id = r?.data?.data?.[0]?.id;
      if (typeof id === "number") return { userId: id, usernameForReport: name };
    } catch {}
  }

  // 2) fallback: search público por keyword (pega username real e faz fuzzy)
  try {
    const r = await axios.get(
      `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(name)}&limit=10`,
      { validateStatus: () => true }
    );

    const list = r?.data?.data || [];
    if (!Array.isArray(list) || list.length === 0) return null;

    // escolha melhor match comparando com username e displayName
    const target = name.toLowerCase();
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const u of list) {
      const uname = String(u?.name || "");
      const dname = String(u?.displayName || "");

      const s1 = levenshtein(target, uname.toLowerCase());
      const s2 = levenshtein(target, dname.toLowerCase());
      const s = Math.min(s1, s2);

      if (s < bestScore) {
        bestScore = s;
        best = u;
      }
    }

    if (best?.id) {
      const username = String(best.name || "").trim() || name;
      return { userId: best.id, usernameForReport: cleanName(username) };
    }
  } catch {}

  return null;
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

  if (res.status() === 401) {
    throw new Error("HTTP 401 — cookie expirou/foi invalidado.");
  }

  if (res.status() < 200 || res.status() >= 300) {
    let body = "";
    try { body = JSON.stringify(await res.json()).slice(0, 260); } catch {}
    throw new Error(`HTTP ${res.status()} ${body}`);
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

function cleanupRecentPunish() {
  const t = now();
  for (const [k, ts] of punishedRecently.entries()) {
    if (t - ts > RECENT_PUNISH_TTL_MS) punishedRecently.delete(k);
  }
}

function alreadyPunishedRecently(key) {
  cleanupRecentPunish();
  return punishedRecently.has(key);
}

function markPunishedRecently(key) {
  punishedRecently.set(key, now());
}
/* ========================================= */

/* ================= PUNIÇÃO ================= */
async function punishActor(nameFromOCR) {
  const raw = cleanName(nameFromOCR);
  if (!raw) return;

  // não repetir punir por OCR variar
  if (alreadyPunishedRecently(raw)) return;

  if (!canPunish(raw)) return;

  // resolve userId (com fuzzy)
  const resolved = await resolveUserIdPublic(raw);
  if (!resolved) {
    console.error(`⚠️ Falha ao exilar ${raw}: Não consegui resolver userId (provável display/typo).`);
    // evita spam infinito
    markPunished(raw);
    markPunishedRecently(raw);
    return;
  }

  const { userId, usernameForReport } = resolved;

  // 1) kick
  try {
    await kickFromGroup(userId);
    console.log(`✅ Kick OK: ${usernameForReport} (id=${userId})`);
  } catch (e) {
    console.error(`⚠️ Falha ao exilar ${usernameForReport}:`, String(e?.message || e));
    // evita loop infinito
    markPunished(raw);
    markPunishedRecently(raw);
    return;
  }

  // 2) marca punido (mesmo se discord falhar)
  markPunished(raw);
  markPunishedRecently(raw);

  // 3) discord (se falhar: só log)
  try {
    await sendDiscord(formatRelatorioExilio(usernameForReport));
    console.log(`📣 Relatório enviado: ${usernameForReport}`);
  } catch (e) {
    console.error(`⚠️ Discord falhou ao enviar relatório (${usernameForReport}):`, String(e?.message || e));
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

    // baseline (primeira leitura)
    if (!baselineReady) {
      lastEventKeys = new Set(events.map(e => `${e.who}|${e.action}|${e.when}`));
      baselineReady = true;
      console.log("✅ Baseline setado. Próximas mudanças serão avaliadas.");
      return;
    }

    if (!events.length) return;

    const currentKeys = new Set(events.map(e => `${e.who}|${e.action}|${e.when}`));
    const newKeys = [...currentKeys].filter(k => !lastEventKeys.has(k));
    lastEventKeys = currentKeys;

    if (!newKeys.length) return;

    for (const k of newKeys) {
      const [who] = k.split("|").map(x => x.trim());

      recordActor(who);

      if (shouldPunish(who)) {
        await punishActor(who);
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

  await monitorar(); // seta baseline
  setInterval(monitorar, INTERVALO);
})();
