import { firefox } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";

/* ================= SAFETY ================= */
process.on("uncaughtException", err => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", err => {
  console.error("❌ Unhandled Rejection:", err);
});

process.on("exit", code => {
  console.log("⚠️ Processo finalizado com código:", code);
});
/* ========================================= */

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
let COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const DISCORD_RESPONSAVEL_ID = "1455692969322614895";
const INTERVALO = Number(process.env.INTERVALO_MS || "5000");
const TEST_MODE = String(process.env.TEST_MODE || "1") === "1";

const WINDOW_BURST_MS = 10_000;
const BURST_THRESHOLD = 3;
const VOLUME_WINDOW_MS = 300_000;
const VOLUME_THRESHOLD = 10;
const PUNISH_COOLDOWN_MS = 30 * 60 * 1000;
const DEBUG_EXILE = String(process.env.DEBUG_EXILE || "0") === "1";

const AUDIT_URL = `https://www.roblox.com/groups/configure?id=${GROUP_ID}#!/auditLog`;
/* ========================================= */

if (!GROUP_ID || !COOKIE || !WEBHOOK || !OPENAI_KEY) {
  console.error("❌ Faltando env obrigatória");
  process.exit(1);
}

/* ================= SANITIZE COOKIE ================= */
COOKIE = COOKIE.trim();
if ((COOKIE.startsWith('"') && COOKIE.endsWith('"')) || (COOKIE.startsWith("'") && COOKIE.endsWith("'"))) {
  COOKIE = COOKIE.slice(1, -1);
}
if (COOKIE.startsWith(".ROBLOSECURITY=")) {
  COOKIE = COOKIE.replace(".ROBLOSECURITY=", "");
}
/* ========================================= */

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ================= ROBLOX AXIOS ================= */
let csrfToken = null;
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0"
  },
  validateStatus: () => true
});
/* ========================================= */

let running = false;
let lastImgHash = "";
let lastParsedLines = new Set();
const actorEvents = new Map();
const punishedUntil = new Map();

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

function formatRelatorioExilio(username) {
  return `***Relatório de Exílio!**

Responsável: <@${DISCORD_RESPONSAVEL_ID}>
Exilado(a): ${username}
Motivo: Accept-all
Data: ${new Date().toLocaleDateString("pt-BR")}***`;
}
/* ========================================= */

function normalizeUsernameFromActor(raw) {
  const m = String(raw || "").match(/@([A-Za-z0-9_]{3,20})/);
  return m?.[1] || raw.replace(/^@/, "").split(/\s+/)[0];
}

/* ================= PLAYWRIGHT ================= */
async function closeSilently() {
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  page = context = browser = null;
}

async function initBrowser() {
  await closeSilently();

  console.log("🌐 Iniciando Firefox...");
  browser = await firefox.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });

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
  await page.goto("https://www.roblox.com/home", { waitUntil: "domcontentloaded" });
  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded" });
}

function sha256File(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

async function capturarAudit() {
  if (!page || page.isClosed()) await initBrowser();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "audit.png" });
}
/* ========================================= */

/* ================= OPENAI OCR ================= */
async function ocrAuditToLines() {
  const base64 = fs.readFileSync("audit.png").toString("base64");

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: 200,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Extraia eventos aceitou/recusou e retorne: username | ação" },
        { type: "input_image", image_url: `data:image/png;base64,${base64}` }
      ]
    }]
  });

  const text = resp.output_text?.trim();
  if (!text) return [];

  return text.split("\n").filter(l => l.includes("|"));
}
/* ========================================= */

/* ================= LOOP ================= */
async function monitorar() {
  if (running) return;
  running = true;

  try {
    await capturarAudit();

    const h = sha256File("audit.png");
    if (h === lastImgHash) return;
    lastImgHash = h;

    const lines = await ocrAuditToLines();
    const newLines = lines.filter(l => !lastParsedLines.has(l));
    lastParsedLines = new Set(lines);

    for (const l of newLines) {
      const [actorRaw] = l.split("|");
      const actor = normalizeUsernameFromActor(actorRaw);
      if (!actor) continue;
      await sendDiscord(formatRelatorioExilio(actor));
    }
  } catch (e) {
    console.error("Erro monitor:", e);
    await closeSilently();
  } finally {
    running = false;
  }
}

(async () => {
  console.log("🛡️ BOT INICIANDO...");
  await initBrowser();
  setInterval(monitorar, INTERVALO);
})();
