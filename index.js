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

const INTERVALO = Number(process.env.INTERVALO_MS || "300000"); // produção: 5 min
const TEST_MODE = String(process.env.TEST_MODE || "0") === "1"; // ✅ padrão OFF

// ✅ regra nova: 3+ ações no MESMO minuto => exílio
const SAME_MINUTE_THRESHOLD = Number(process.env.SAME_MINUTE_THRESHOLD || "3");

// (extra anti-bypass opcional) volume em 5 min
const VOLUME_WINDOW_MS = 300_000;
const VOLUME_THRESHOLD = Number(process.env.VOLUME_THRESHOLD || "10");

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

/* ================= DISCORD ================= */
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
let baselineReady = false;

const punishedUntil = new Map(); // nameKey -> cooldownUntil

// Para regra "mesmo minuto"
const actorMinuteCounts = new Map(); // actorKey -> Map(minuteKey -> count)

// (extra) para volume em 5 min
const actorTimes = new Map(); // actorKey -> timestamps[]
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
function isLikelyUsername(s) {
  const t = String(s || "").trim().replace(/^@/, "");
  return /^[a-zA-Z0-9_]{3,20}$/.test(t);
}

// tenta extrair algo do tipo "01 de jan. de 2026 03:30" ou só "03:30"
function normalizeMinuteKey(whenRaw) {
  const w = String(whenRaw || "").trim();

  // pega HH:MM se existir
  const hm = w.match(/(\d{1,2}:\d{2})/);
  const hhmm = hm ? hm[1] : null;

  // tenta pegar parte de data PT-BR (bem permissivo)
  // ex: "01 de jan. de 2026"
  const datePt = w.match(/(\d{1,2}\s+de\s+[a-zçãé\.]+(?:\s+de)?\s+\d{4})/i);
  const datePart = datePt ? datePt[1].toLowerCase() : null;

  if (datePart && hhmm) return `${datePart} ${hhmm}`;
  if (hhmm) return hhmm;

  // se não tem nada útil, cai pro minuto atual do servidor
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `local ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

Extraia SOMENTE eventos de pedidos de entrada (aceitou/recusou).
IMPORTANTE:
- Se aparecer Display Name grande e abaixo "@username", use SEMPRE o @username (sem @ no output).
- Se NÃO aparecer @username, retorne o Display Name mesmo assim (pra eu resolver depois).
- QUANDO: copie o tempo visível exatamente (ex: "01 de jan. de 2026 03:30" ou "03:30").

Formato (1 linha por evento):
NOME | ACAO | QUANDO

- ACAO: aceitou ou recusou

Se não houver eventos desse tipo, responda exatamente:
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

  if (res.status() === 401) {
    throw new Error(`HTTP 401 (User is not authenticated) — cookie expirou/foi invalidado.`);
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

function canPunish(key) {
  return (punishedUntil.get(key) || 0) <= now();
}

function markPunished(key) {
  punishedUntil.set(key, now() + PUNISH_COOLDOWN_MS);
}

// conta por minuto (mesmo minuto => soma)
function recordMinute(actorKey, minuteKey) {
  if (!actorMinuteCounts.has(actorKey)) actorMinuteCounts.set(actorKey, new Map());
  const m = actorMinuteCounts.get(actorKey);

  const cur = (m.get(minuteKey) || 0) + 1;
  m.set(minuteKey, cur);

  // limpa minutos velhos (mantém só últimos ~5 minutos por segurança)
  if (m.size > 8) {
    // remove chaves mais antigas por ordem de inserção
    const keys = [...m.keys()];
    for (let i = 0; i < keys.length - 8; i++) m.delete(keys[i]);
  }

  return cur;
}

// (extra) volume em 5 min
function recordVolume(actorKey) {
  const t = now();
  if (!actorTimes.has(actorKey)) actorTimes.set(actorKey, []);
  actorTimes.get(actorKey).push(t);
  const cutoff = t - VOLUME_WINDOW_MS;
  actorTimes.set(actorKey, actorTimes.get(actorKey).filter(x => x >= cutoff));
  return actorTimes.get(actorKey).length;
}

function shouldPunish(actorKey, minuteCount, volumeCount) {
  if (TEST_MODE) return true;

  // ✅ regra pedida:
  if (minuteCount >= SAME_MINUTE_THRESHOLD) return true;

  // extra anti-bypass (se quiser manter)
  if (volumeCount >= VOLUME_THRESHOLD) return true;

  return false;
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

  // 3) relatório
  try {
    await sendDiscord(formatRelatorioExilio(usernameForReport));
    console.log(`📣 Relatório enviado no Discord: ${usernameForReport}`);
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

    // processa eventos novos
    for (const key of newKeys) {
      const [name, action, when] = key.split("|").map(x => x.trim());

      const actorKey = name.replace(/^@/, "").trim();
      const minuteKey = normalizeMinuteKey(when);

      const minuteCount = recordMinute(actorKey, minuteKey);
      const volumeCount = recordVolume(actorKey);

      // log debug útil
      console.log(`📌 Evento: ${actorKey} ${action} | minuto="${minuteKey}" | countMin=${minuteCount} | vol5m=${volumeCount}`);

      if (shouldPunish(actorKey, minuteCount, volumeCount)) {
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

  console.log(`🛡️ Rodando | TEST_MODE=${TEST_MODE} | INTERVALO=${INTERVALO}ms`);
  console.log(`✅ Regra: >=${SAME_MINUTE_THRESHOLD} ações no mesmo minuto (mesmo usuário) => exílio.`);
  console.log("ℹ️ Primeira captura = baseline (não pune ninguém).");

  await monitorar(); // seta baseline
  setInterval(monitorar, INTERVALO);
})();
