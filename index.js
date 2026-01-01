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
  console.error("❌ Faltando env obrigatórias.");
  process.exit(1);
}

/* ================= COOKIE ================= */
COOKIE = COOKIE.trim();
if ((COOKIE.startsWith('"') && COOKIE.endsWith('"')) || (COOKIE.startsWith("'") && COOKIE.endsWith("'"))) {
  COOKIE = COOKIE.slice(1, -1).trim();
}
if (COOKIE.startsWith(".ROBLOSECURITY=")) {
  COOKIE = COOKIE.replace(".ROBLOSECURITY=", "").trim();
}
/* ========================================= */

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ================= DISCORD ================= */
async function sendDiscord(content) {
  await axios.post(WEBHOOK, { content });
}

function formatRelatorioExilio(username) {
  const data = new Date().toLocaleDateString("pt-BR");
  return (
`***Relatório de Exílio!

Responsável: <@${DISCORD_RESPONSAVEL_ID}>

Exilado(a): ${username}

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

const actorTimes = new Map();
const punishedUntil = new Map();
/* ========================================= */

/* ================= PLAYWRIGHT ================= */
let browser, context, page, api, csrfToken;

function ensureBrowsers() {
  try {
    execSync("npx playwright install firefox", { stdio: "inherit" });
  } catch {
    console.error("❌ Falha ao instalar Firefox.");
    process.exit(1);
  }
}

async function initBrowser() {
  try {
    browser = await firefox.launch({ headless: true });
  } catch {
    ensureBrowsers();
    browser = await firefox.launch({ headless: true });
  }

  context = await browser.newContext();
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

  await page.goto("https://www.roblox.com/home", { waitUntil: "domcontentloaded" });

  const auth = await api.get("https://users.roblox.com/v1/users/authenticated");
  if (auth.status() !== 200) {
    console.error("❌ Cookie inválido.");
    process.exit(1);
  }

  const logout = await api.post("https://auth.roblox.com/v2/logout");
  csrfToken = logout.headers()["x-csrf-token"];

  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded" });
}
/* ========================================= */

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/* ================= OCR ================= */
async function ocrAuditEvents() {
  const base64 = fs.readFileSync("audit.png").toString("base64");

  const res = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text:
`Leia o Audit Log do Roblox.

REGRA OBRIGATÓRIA:
- Use SOMENTE o @username (não use display name).
- Se não houver @username visível, IGNORE o evento.

Formato:
@username | aceitou OU recusou | tempo

Se não houver eventos válidos, responda:
SEM ALTERACOES`
        },
        { type: "input_image", image_url: `data:image/png;base64,${base64}` }
      ]
    }]
  });

  const text = (res.output_text || "").trim();
  if (!text || text === "SEM ALTERACOES") return [];

  return text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("@"))
    .map(l => {
      const [u, action, when] = l.split("|").map(x => x.trim());
      return {
        username: u.replace("@", ""),
        action,
        when
      };
    });
}
/* ========================================= */

/* ================= ROBLOX ================= */
async function resolveUserId(username) {
  const res = await api.post("https://users.roblox.com/v1/usernames/users", {
    data: { usernames: [username], excludeBannedUsers: false }
  });
  if (!res.ok()) return null;
  const j = await res.json();
  return j?.data?.[0]?.id ?? null;
}

async function kickFromGroup(userId) {
  const res = await api.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`,
    { headers: { "x-csrf-token": csrfToken } }
  );
  if (res.status() < 200 || res.status() >= 300) {
    throw new Error(`Kick falhou (${res.status()})`);
  }
}
/* ========================================= */

function recordActor(u) {
  const t = Date.now();
  if (!actorTimes.has(u)) actorTimes.set(u, []);
  actorTimes.get(u).push(t);
  actorTimes.set(u, actorTimes.get(u).filter(x => t - x <= VOLUME_WINDOW_MS));
}

function shouldPunish(u) {
  if (TEST_MODE) return true;
  const arr = actorTimes.get(u) || [];
  const burst = arr.filter(x => Date.now() - x <= BURST_WINDOW_MS).length;
  return burst >= BURST_THRESHOLD || arr.length >= VOLUME_THRESHOLD;
}

async function punishActor(username) {
  if ((punishedUntil.get(username) || 0) > Date.now()) return;

  const userId = await resolveUserId(username);
  if (!userId) {
    console.error(`❌ Username inválido: ${username}`);
    return;
  }

  await kickFromGroup(userId);
  await sendDiscord(formatRelatorioExilio(username));
  punishedUntil.set(username, Date.now() + PUNISH_COOLDOWN_MS);
}

/* ================= LOOP ================= */
async function monitorar() {
  if (running) return;
  running = true;

  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.screenshot({ path: "audit.png" });

    const h = sha256File("audit.png");
    if (h === lastImgHash) return;
    lastImgHash = h;

    const events = await ocrAuditEvents();
    if (!baselineReady) {
      lastEventKeys = new Set(events.map(e => `${e.username}|${e.action}|${e.when}`));
      baselineReady = true;
      console.log("✅ Baseline definido.");
      return;
    }

    for (const e of events) {
      const key = `${e.username}|${e.action}|${e.when}`;
      if (lastEventKeys.has(key)) continue;
      lastEventKeys.add(key);

      recordActor(e.username);
      if (shouldPunish(e.username)) {
        await punishActor(e.username);
      }
    }

  } catch (e) {
    console.error("Erro:", e.message);
  } finally {
    running = false;
  }
}

/* ================= START ================= */
(async () => {
  await initBrowser();
  await monitorar(); // baseline
  setInterval(monitorar, INTERVALO);
})();
