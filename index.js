import { chromium } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const INTERVALO = 5000;      // 5s teste
const JANELA_MS = 10000;    // 10s
const LIMITE_RAPIDO = 3;    // suspeito
/* ========================================= */

if (!GROUP_ID || !COOKIE || !WEBHOOK || !OPENAI_KEY) {
  console.error("❌ Variáveis de ambiente faltando");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const historico = new Map();
let ultimoTexto = "";

/* ================= SCREENSHOT ================= */
async function capturarAudit() {
  const userDataDir = path.join(os.tmpdir(), "pw-user-data");

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--disable-features=VizDisplayCompositor",
      "--mute-audio"
    ]
  });

  await context.addCookies([{
    name: ".ROBLOSECURITY",
    value: COOKIE,
    domain: ".roblox.com",
    path: "/",
    httpOnly: true,
    secure: true
  }]);

  const page = await context.newPage();

  await page.goto(`https://www.roblox.com/groups/${GROUP_ID}/audit-log`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: "audit.png" });
  await context.close();
}
/* ============================================= */

/* ================= OPENAI OCR ================= */
async function analisarImagem() {
  const img = fs.readFileSync("audit.png");
  const base64 = img.toString("base64");

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
`Leia o audit log do grupo Roblox.

Retorne UMA ação por linha no formato:
RESPONSAVEL | ACAO | ALVO

Exemplo:
Japex | aceitou | Player123

Se não houver alterações, responda exatamente:
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

  fs.unlinkSync("audit.png");
  return response.output_text.trim();
}
/* =============================================== */

/* ================= DISCORD ================= */
async function enviarWebhook(responsavel, alvo, motivo) {
  const msg =
`📄 **Relatório de Exílio!**

👤 **Responsável:** ${responsavel}
🚫 **Exilado(a):** ${alvo}
📝 **Motivo:** ${motivo}
🕒 **Data:** ${new Date().toLocaleString("pt-BR")}`;

  await axios.post(WEBHOOK, { content: msg });
}
/* =========================================== */

/* ================= MONITOR ================= */
async function monitorar() {
  try {
    await capturarAudit();
    const texto = await analisarImagem();

    if (!texto || texto === ultimoTexto || texto === "SEM ALTERACOES") return;
    ultimoTexto = texto;

    const agora = Date.now();
    const linhas = texto.split("\n");

    for (const linha of linhas) {
      if (!linha.includes("|")) continue;

      const [ator, acao, alvo] = linha.split("|").map(t => t.trim());

      if (!historico.has(ator)) historico.set(ator, []);
      historico.get(ator).push(agora);

      const recentes = historico
        .get(ator)
        .filter(t => agora - t <= JANELA_MS);

      historico.set(ator, recentes);

      let motivo = `${acao} ${alvo}`;
      if (recentes.length >= LIMITE_RAPIDO) {
        motivo += " (atividade rápida suspeita)";
      }

      await enviarWebhook(ator, alvo, motivo);
    }

  } catch (err) {
    console.error("Erro no monitor:", err.message);
  }
}
/* =========================================== */

console.log("🛡️ Auditoria visual Roblox ATIVA (modo teste)");
setInterval(monitorar, INTERVALO);
