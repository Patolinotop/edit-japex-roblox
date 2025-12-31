import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;

const LIMITE = 2;            // Ações máximas permitidas na janela
const JANELA_MS = 2000;    // Janela de tempo (10 segundos)
const INTERVALO = 5000;      // A cada 5 segundos
// ==========================================

let csrfToken = null;
const logsRecentes = new Map(); // Armazena logs por usuário

const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "RobloxBot/1.0"
  },
  validateStatus: () => true
});

// Atualiza CSRF
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
}

// Exilar usuário
async function exilarUsuario(userId) {
  if (!csrfToken) await refreshCSRF();

  const res = await roblox.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
  );

  if (res.status === 403) {
    await refreshCSRF();
    await roblox.delete(
      `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
    );
  }
}

// Relatório Discord
async function enviarRelatorio(username, motivo) {
  const agora = new Date().toLocaleString("pt-BR");
  const mensagem = `**> 『 RELATÓRIO DE DEMISSÃO 』
> =================================
> ➩ Usuário expulso: ${username}
> ➩ Motivo: ${motivo}
> =================================
> ➩ Data e hora: ${agora}
> ➩ Comprovações: Logs do grupo
> =================================**`;

  await axios.post(WEBHOOK, { content: mensagem });
}

// Buscar logs do grupo
async function getGroupLogs(limit = 20) {
  const query = {
    query: `
      query GroupAuditLog($groupId: ID!, $limit: Int) {
        groupAuditLog(groupId: $groupId, limit: $limit) {
          data {
            actor {
              userId
              username
            }
            actionType
            description
            created
            actorRank
          }
        }
      }
    `,
    variables: {
      groupId: GROUP_ID,
      limit: limit
    }
  };

  const res = await roblox.post("https://groups.roblox.com/graphql", query);

  if (res.status !== 200) return [];

  return res.data.data.groupAuditLog.data.filter(log =>
    log.actionType === "AcceptJoinRequest"
  );
}

// Monitoramento
async function monitorar() {
  try {
    const agora = Date.now();
    const logs = await getGroupLogs();

    logs.forEach(log => {
      const userId = log.actor.userId;
      const username = log.actor.username;
      const timestamp = new Date(log.created).getTime();

      if (!logsRecentes.has(userId)) logsRecentes.set(userId, []);
      logsRecentes.get(userId).push(timestamp);

      const recentes = logsRecentes.get(userId).filter(t => agora - t <= JANELA_MS);
      logsRecentes.set(userId, recentes);

      if (recentes.length >= LIMITE) {
        exilarUsuario(userId);
        enviarRelatorio(username, `Detectado aceitando ${recentes.length} membros em menos de ${JANELA_MS / 1000}s.`);
        logsRecentes.delete(userId);
      }
    });

  } catch (e) {
    console.error("Erro:", e.response?.status || e.message);
  }
}

(async () => {
  await refreshCSRF();
  console.log("🛡️ Anti Accept-All via Logs ativo com CSRF");
  setInterval(monitorar, INTERVALO);
})();
