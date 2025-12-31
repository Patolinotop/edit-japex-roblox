import { chromium } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const INTERVALO = 5000;      // 5s (teste)
const JANELA_MS = 10000;    // 10s
const LIMITE_RAPIDO = 3;    // 3 ações rápidas
// =========================================

const openai = new OpenAI({ apiKey: OPENAI_KEY });

const historico = new Map();
let ultimoTexto = "";

// ================= SCREENSHOT =================
async function capturarAudit() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"]
  });

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
  await page.goto(`https://www.roblox.com/groups/${GROUP_ID}/audit-log`, {
    waitUntil: "networkidle"
  });

  await page.reload();
  await page.waitForTimeout(3000);

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
`Leia o audit log do grupo Roblox.

Retorne UMA ação por linha no formato:
APROVADOR | AÇÃO | ALVO

Exemplo:
Japex | aceitou | Player123

Se não houver mudanças, responda exatamente:
SEM ALTERACOES`
        },
        {
          type: "input_image",
          image_base64: img.toString("base64")
        }
      ]
    }]
  });

  fs.unlinkSync("audit.png");
  return res.output_text.trim();
}
// =====================================

// ================= DISCORD =================
async function enviarWebhook(conteudo) {
  await axios.post(WEBHOOK, { content: conteudo });
}
// =========================================

// ================= MONITOR =================
async function monitorar() {
  try {
    await capturarAudit();
    const texto = await analisarImagem();

    if (!texto || texto === ultimoTexto) return;
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

      const relatorio =
`📄 **Relatório de Exílio!**

👤 **Responsável:** ${ator}
🚫 **Exilado(a):** ${alvo}
📝 **Motivo:** ${motivo}
🕒 **Data:** ${new Date().toLocaleString("pt-BR")}`;

      await enviarWebhook(relatorio);
    }

  } catch (e) {
    console.error("Erro no monitor:", e.message);
  }
}
// =========================================

// ================= START =================
console.log("🛡️ Auditoria visual Roblox ATIVA (modo teste)");
setInterval(monitorar, INTERVALO);
