import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;              // ID do grupo (somente números)
const COOKIE = process.env.ROBLOSECURITY;           // Cookie válido (conta com permissão)
const WEBHOOK = process.env.DISCORD_WEBHOOK;        // Webhook Discord

// ===== CONFIG DE TESTE =====
const LIMITE = 1;            // 1 aceitação já pune (TESTE)
const JANELA_MS = 5000;      // 5 segundos
const INTERVALO = 4000;      // checagem a cada 4s
const AUDIT_LIMIT = 25;      // quantos logs puxar por vez (1 a 100)
// ===========================

// ================= VALIDAÇÕES =================
function assertEnv() {
  const faltando = [];
  if (!GROUP_ID) faltando.push("GROUP_ID");
  if (!COOKIE) faltando.push("ROBLOSECURITY");
  if (!WEBHOOK) faltando.push("DISCORD_WEBHOOK");

  if (faltando.length) {
    console.error("❌ Variáveis faltando:", faltando.join(", "));
    process.exit(1);
  }

  if (!/^\d+$/.test(String(GROUP_ID))) {
    console.error("❌ GROUP_ID inválido. Tem que ser só números. Recebido:", GROUP_ID);
    process.exit(1);
  }
}
// ==============================================

let csrfToken = null;
const historico = new Map();         // userId -> timestamps
const logsProcessados = new Set();   // evita duplicação

// ================= CLIENT ROBLOX =================
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 RobloxBot",
    "Accept": "application/json",
    "Referer": `https://www.roblox.com/groups/${GROUP_ID}/audit-log`
  },
  validateStatus: () => true
});
// ================================================

// ================= CSRF =================
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  if (csrfToken) roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
}
// =========================================

// ================= AÇÕES =================
async function exilarUsuario(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
  );

  if (res.status === 403) {
    await refreshCSRF();
    res = await roblox.delete(
      `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
    );
  }

  // Debug útil
  if (res.status !== 200) {
    console.log("⚠️ Exílio retornou:", res.status);
  }
}

async function enviarRelatorio(username, qtd, desc) {
  const agora = new Date().toLocaleString("pt-BR");

  const mensagem = `**🚨 『 ANTI ACCEPT-ALL 』 🚨**\n\n` +
                   `👤 Usuário punido: **${username}**\n` +
                   `📌 Aceitações: **${qtd}**\n` +
                   `⏱️ Janela: ${JANELA_MS / 1000}s\n` +
                   `🧾 Log: ${desc || "(sem descrição)"}\n` +
                   `🕒 Data/Hora: ${agora}`;

  await axios.post(WEBHOOK, { content: mensagem });
}
// =========================================

// ================= LOGS DO GRUPO (REST OFICIAL) =================
async function getGroupLogs(limit = AUDIT_LIMIT) {
  // Roblox geralmente aceita limit 1..100
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));

  const url = `https://groups.roblox.com/v1/groups/${GROUP_ID}/audit-log?limit=${safeLimit}&sortOrder=Desc`;
  const res = await roblox.get(url);

  if (res.status !== 200 || !res.data?.data) {
    // Mostrar corpo ajuda MUITO a entender o 400
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    console.error("Erro ao puxar logs", res.status, body?.slice(0, 600));
    return [];
  }

  return res.data.data;
}
// ===============================================================

// ================= MONITOR =================
async function monitorar() {
  try {
    const agora = Date.now();
    const logs = await getGroupLogs();

    for (const log of logs) {
      if (!log?.id || logsProcessados.has(log.id)) continue;
      logsProcessados.add(log.id);

      const desc = (log.description || "").toLowerCase();

      // Detecção por texto PT-BR/EN (pra não depender do actionType)
      const aceitouPT = desc.includes("aceitou o pedido");
      const acceptedEN = desc.includes("accepted") && desc.includes("join request");
      if (!aceitouPT && !acceptedEN) continue;

      const userId = log.actor?.userId;
      const username = log.actor?.username;
      if (!userId || !username) continue;

      const timestamp = new Date(log.created).getTime();

      if (!historico.has(userId)) historico.set(userId, []);
      historico.get(userId).push(timestamp);

      const recentes = historico
        .get(userId)
        .filter(t => agora - t <= JANELA_MS);

      historico.set(userId, recentes);

      if (recentes.length >= LIMITE) {
        console.log(`🚫 Punindo ${username} por muitas aceitações (${recentes.length})`);
        await exilarUsuario(userId);
        await enviarRelatorio(username, recentes.length, log.description);
        historico.delete(userId);
      }
    }

    // limpeza básica do set pra não crescer infinito
    if (logsProcessados.size > 5000) {
      logsProcessados.clear();
    }

  } catch (e) {
    console.error("Erro no monitor:", e.response?.status || e.message);
  }
}
// =========================================

// ================= START =================
(async () => {
  assertEnv();
  await refreshCSRF();
  console.log("🛡️ Anti Accept-All ATIVO (audit-log REST oficial)");
  setInterval(monitorar, INTERVALO);
})();
