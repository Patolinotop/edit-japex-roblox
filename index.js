import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;              // ID do grupo
const COOKIE = process.env.ROBLOSECURITY;           // Cookie da conta com permissão
const WEBHOOK = process.env.DISCORD_WEBHOOK;        // Webhook Discord

// ===== CONFIG DE TESTE (AJUSTE MANUALMENTE) =====
const LIMITE = 1;            // Quantas aceitações já punem (TESTE = 1)
const JANELA_MS = 5000;      // Janela de tempo (ms)
const INTERVALO = 4000;      // Intervalo de checagem (ms)
// ================================================

// ================= VARIÁVEIS =================
let csrfToken = null;
const historico = new Map();     // userId -> [timestamps]
const logsProcessados = new Set(); // evita processar log repetido
// ==============================================

// ================= CLIENT ROBLOX =================
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "RobloxBot/1.0",
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

// ================= AÇÕES =================
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
  const agora = new Date().toLocaleString("pt-BR");

  const mensagem = `**🚨 『 ANTI ACCEPT-ALL 』 🚨**\n\n` +
                   `👤 Usuário punido: **${username}**\n` +
                   `📌 Aceitações detectadas: **${qtd}**\n` +
                   `⏱️ Janela: ${JANELA_MS / 1000}s\n` +
                   `🕒 Data/Hora: ${agora}`;

  await axios.post(WEBHOOK, { content: mensagem });
}
// =========================================

// ================= LOGS DO GRUPO =================
async function getGroupLogs(limit = 20) {
  const payload = {
    query: `
      query GroupAuditLog($groupId: ID!, $limit: Int!) {
        groupAuditLog(groupId: $groupId, limit: $limit) {
          data {
            id
            created
            description
            actor {
              userId
              username
            }
          }
        }
      }
    `,
    variables: {
      groupId: GROUP_ID,
      limit
    }
  };

  const res = await roblox.post("https://groups.roblox.com/graphql", payload);

  if (res.status !== 200 || !res.data?.data) {
    console.error("Erro ao puxar logs", res.status);
    return [];
  }

  return res.data.data.groupAuditLog.data;
}
// ===============================================

// ================= MONITOR =================
async function monitorar() {
  try {
    const agora = Date.now();
    const logs = await getGroupLogs();

    for (const log of logs) {
      if (!log?.id || logsProcessados.has(log.id)) continue;
      logsProcessados.add(log.id);

      // DETECÇÃO POR TEXTO (mais confiável)
      if (!log.description?.toLowerCase().includes("aceitou o pedido")) continue;

      const userId = log.actor.userId;
      const username = log.actor.username;
      const timestamp = new Date(log.created).getTime();

      if (!historico.has(userId)) historico.set(userId, []);

      historico.get(userId).push(timestamp);

      const recentes = historico
        .get(userId)
        .filter(t => agora - t <= JANELA_MS);

      historico.set(userId, recentes);

      if (recentes.length >= LIMITE) {
        console.log(`🚫 Punindo ${username} por accept-all`);
        await exilarUsuario(userId);
        await enviarRelatorio(username, recentes.length);
        historico.delete(userId);
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
  console.log("🛡️ Anti Accept-All ATIVO (logs reais do grupo)");
  setInterval(monitorar, INTERVALO);
})();
