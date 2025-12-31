import { firefox } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const INTERVALO = 5000;      // 5s teste
const JANELA_MS = 10000;     // 10s
const LIMITE_RAPIDO = 3;     // suspeito
/* ========================================= */

if (!GROUP_ID || !COOKIE || !WEBHOOK || !OPENAI_KEY) {
  console.error("❌ Variáveis faltando: GROUP_ID / ROBLOSECURITY / DISCORD_WEBHOOK / OPENAI_API_KEY");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

const historico = new Map();
let ultimoTexto = "";
let running = false;

// sessão do browser (reuso)
let browser = null;
let context = null;
let page = null;

const AUDIT_URL = `https://www.roblox.com/groups/${GROUP_ID}/audit-log`;

async function initBrowser() {
  await closeBrowserSilently();

  browser = await firefox.launch({ headless: true });
  context = await browser.newContext();

  await context.addCookies([{
    name: ".ROBLOSECURITY",
    value: COOKIE,
    domain: ".roblox.com",
    path: "/",
    httpOnly: true,
    secure: true
  }]);

  page = await context.newPage();

  await page.goto(AUDIT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  // uma “aquecida”
  await page.waitForTimeout(2000);
}

async function closeBrowserSilently() {
  try { if (page) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  page = null; context = null; browser = null;
}

async function capturarAudit() {
  // Recarrega pra pegar novidades
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "audit.png" });
}

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

Se não houver alterações relevantes, responda exatamente:
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

  // apaga sempre
  try { fs.unlinkSync("audit.png"); } catch {}
  return (response.output_text || "").trim();
}

async function enviarWebhook(responsavel, alvo, motivo) {
  const msg =
`📄 **Relatório de Exílio!**

👤 **Responsável:** ${responsavel}
🚫 **Exilado(a):** ${alvo}
📝 **Motivo:** ${motivo}
🕒 **Data:** ${new Date().toLocaleString("pt-BR")}`;

  await axios.post(WEBHOOK, { content: msg });
}

async function processarTexto(texto) {
  const agora = Date.now();
  const linhas = texto.split("\n").map(l => l.trim()).filter(Boolean);

  for (const linha of linhas) {
    if (!linha.includes("|")) continue;

    const [ator, acao, alvo] = linha.split("|").map(t => t.trim());
    if (!ator || !acao || !alvo) continue;

    if (!historico.has(ator)) historico.set(ator, []);
    historico.get(ator).push(agora);

    const recentes = historico.get(ator).filter(t => agora - t <= JANELA_MS);
    historico.set(ator, recentes);

    let motivo = `${acao} ${alvo}`;
    if (recentes.length >= LIMITE_RAPIDO) {
      motivo += " (atividade rápida suspeita)";
    }

    // (modo teste): qualquer alteração manda webhook
    await enviarWebhook(ator, alvo, motivo);
  }
}

async function monitorar() {
  if (running) return;
  running = true;

  try {
    if (!page) await initBrowser();

    await capturarAudit();
    const texto = await analisarImagem();

    if (!texto || texto === "SEM ALTERACOES") {
      running = false;
      return;
    }

    // evita spam se a OCR repetir exatamente
    if (texto === ultimoTexto) {
      running = false;
      return;
    }
    ultimoTexto = texto;

    await processarTexto(texto);

  } catch (err) {
    console.error("Erro no monitor:", err.message);

    // se o browser morreu, reinicia
    const msg = String(err.message || "");
    if (
      msg.includes("Target closed") ||
      msg.includes("has been closed") ||
      msg.includes("browserType.launch") ||
      msg.includes("Executable doesn't exist")
    ) {
      try { await initBrowser(); } catch {}
    }
  } finally {
    running = false;
  }
}

/* ================= START ================= */
console.log("🛡️ Auditoria visual Roblox ATIVA (Firefox / Playwright 1.57)");
initBrowser()
  .then(() => setInterval(monitorar, INTERVALO))
  .catch((e) => {
    console.error("Falha ao iniciar o browser:", e.message);
    process.exit(1);
  });
