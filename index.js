import axios from "axios";
import { chromium } from "playwright";
import OpenAI from "openai";
import fs from "fs";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ===== AJUSTES =====
const LIMITE = 1;
const JANELA_MS = 5000;
const INTERVALO = 30000; // 30s
// ===================

// ================= VARIÁVEIS =================
let csrfToken = null;
const historico = new Map();
const logsProcessados = new Set();
// ============================================

// ================= OPENAI =================
const openai = new OpenAI({
  apiKey: OPENAI_KEY
});
// ==========================================

// ================= ROBLOX CLIENT =================
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
    "Referer": `https://www.roblox.com/groups/${GROUP_ID}/audit-log`
  },
  validateStatus: () => true
});
// ================================================

// ================= CSRF =================
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
}
// =========================================

// ================= PUNIÇÃO =================
async function exilarUsuario(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
  );

  if (res.status === 403) {
    await refreshCSRF();
    await roblox.delete(
      `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
    );
  }
}

async function enviarRelatorio(username, qtd) {
  const msg =
    `**🚨 ANTI ACCEPT-ALL 🚨**\n\n` +
    `👤 Usuário: **${username}**\n` +
    `📌 Aceitações: **${qtd}**\n` +
    `⏱️ Janela: ${JANELA_MS / 1000}s`;

  await axios.post(WEBHOOK, { content: msg });
}
// ==========================================

// ================= SCREENSHOT =================
async function capturarAudit() {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    storageState: {
      cookies: [{
        name: ".ROBLOSECURITY",
        value: COOKIE,
        domain: ".roblox.com",
        path: "/"
      }]
    }
  });

  const page = await context.newPage();
  await page.goto(`https://www.roblox.com/groups/${GROUP_ID}/audit-log`);
  await page.waitForTimeout(4000);

  await page.screenshot({ path: "audit.png" });

  await browser.close();
}
// =============================================

// ================= IA =================
async function analisarImagem() {
  const img = fs.readFileSync("audit.png");

  const res = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            "Leia o log de auditoria do grupo Roblox. " +
            "Retorne apenas linhas no formato: " +
            "`APROVADOR_USERNAME -> APROVADO_USERNAME`. " +
            "Se não houver novas aceitações, responda 'NENHUMA'."
        },
        {
          type: "input_image",
          image_base64: img.toString("base64")
        }
      ]
    }]
  });

  fs.unlinkSync("audit.png");
  return res.output_text;
}
// =====================================

// ================= MONITOR =================
async function monitorar() {
  try {
    await capturarAudit();
    const texto = await analisarImagem();

    if (!texto || texto.includes("NENHUMA")) return;

    const agora = Date.now();
    const linhas = texto.split("\n");

    for (const linha of linhas) {
      const [aprovador] = linha.split("->").map(t => t.trim());
      if (!aprovador) continue;

      if (!historico.has(aprovador)) historico.set(aprovador, []);
      historico.get(aprovador).push(agora);

      const recentes = historico
        .get(aprovador)
        .filter(t => agora - t <= JANELA_MS);

      historico.set(aprovador, recentes);

      if (recentes.length >= LIMITE) {
        console.log(`🚫 Detectado accept-all: ${aprovador}`);
        await enviarRelatorio(aprovador, recentes.length);
        historico.delete(aprovador);
      }
    }

  } catch (e) {
    console.error("Erro no monitor:", e.message);
  }
}
// =========================================

// ================= START =================
(async () => {
  await refreshCSRF();
  console.log("🛡️ Auditoria visual do Roblox ATIVA");
  setInterval(monitorar, INTERVALO);
})();
