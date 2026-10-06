// ============================================================
// Job de 2 minutos — roda DENTRO do processo do servidor (setInterval),
// não no navegador. Enquanto o servidor estiver de pé (no Render, 24/7
// se o plano for "always on"), este job roda sozinho, independente de
// qualquer navegador/landing page estar aberta.
//
// A cada execução (padrão: a cada 30s — mais fino que 1min para não
// perder a janela de 2 minutos caso o processo tenha ficado momentaneamente
// ocupado), ele:
// 1) busca leads com aiTriggerAt <= agora e aiTriggeredAt ainda nulo;
// 2) para cada um, confere se já existe QUALQUER mensagem registrada
//    (IA, corretor ou cliente) — se sim, pula (alguém já iniciou contato);
// 3) se não, gera a 1ª mensagem e envia via WhatsApp, grava em `messages`
//    e atualiza o lead (aiTriggeredAt, status, conversationStatus).
// ============================================================

const db = require('./db');
const { sendWhatsAppMessage } = require('./whatsapp');
const { generateFirstContactMessage } = require('./ai');

let running = false;

async function dispatchDueLeads() {
  if (running) return { skipped: 'already_running' };
  running = true;
  const now = new Date();
  const results = {};
  try {
    const due = await db.findDueLeads(now, 25);
    for (const lead of due) {
      try {
        const existingCount = await db.countMessagesForLead(lead.id);
        if (existingCount > 0) {
          await db.updateLead(lead.id, { aiTriggeredAt: now });
          results[lead.id] = 'skipped_already_contacted';
          continue;
        }

        const message = await generateFirstContactMessage(lead);
        const phone = lead.whatsapp || lead.phone;
        const sendResult = await sendWhatsAppMessage(phone, message);

        await db.createMessage({
          leadId: lead.id,
          telefone: phone,
          remetente: 'ia',
          conteudo: message,
          tipo: 'texto',
          origem: 'whatsapp',
          status: sendResult.ok ? 'enviado' : 'falhou',
          providerMessageId: sendResult.providerMessageId || null,
        });

        await db.updateLead(lead.id, {
          aiTriggeredAt: now,
          firstContactAt: now,
          lastMessageAt: now,
          conversationStatus: sendResult.ok ? 'ia_contatou' : 'nenhuma',
          status: sendResult.ok ? 'IA Atendendo' : lead.status,
        });

        await db.createEvent({
          leadId: lead.id,
          eventType: sendResult.ok ? 'ai_first_contact_sent' : 'ai_first_contact_failed',
          field: 'status',
          beforeValue: 'Novo',
          afterValue: sendResult.ok ? 'IA Atendendo' : 'Novo',
          actor: 'IA (dispatch job)',
        });

        results[lead.id] = sendResult.ok ? 'sent' : `failed: ${sendResult.error}`;
      } catch (err) {
        console.error('[dispatch] erro no lead', lead.id, err);
        results[lead.id] = `exception: ${String(err)}`;
      }
    }
    return { processed: due.length, results };
  } finally {
    running = false;
  }
}

function startDispatchLoop(intervalMs = 30_000) {
  console.log(`[dispatch] job de verificação iniciado — roda a cada ${intervalMs / 1000}s.`);
  const timer = setInterval(() => {
    dispatchDueLeads().catch(err => console.error('[dispatch] erro no loop', err));
  }, intervalMs);
  // não impede o processo de encerrar graciosamente se precisar
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { dispatchDueLeads, startDispatchLoop };
