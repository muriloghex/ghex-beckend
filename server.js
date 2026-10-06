// ============================================================
// G-HEX — Backend (Node.js / Express)
// Substitui a dependência de Supabase: landing page -> este servidor ->
// MongoDB -> CRM (ghex-crm.html). O job de 2 minutos roda dentro deste
// mesmo processo (src/dispatch.js), de verdade no servidor, não no
// navegador.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./src/db');
const { startDispatchLoop, dispatchDueLeads } = require('./src/dispatch');
const { parseInboundWhatsAppPayload } = require('./src/whatsapp');

const app = express();
app.use(express.json({ limit: '100kb' }));

const LANDING_PAGE_ORIGIN = process.env.LANDING_PAGE_ORIGIN || '*';
const LEAD_WEBHOOK_SECRET = process.env.LEAD_WEBHOOK_SECRET || '';
const CRM_API_KEY = process.env.CRM_API_KEY || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';

// ---------- CORS ----------
// Endpoint público (landing page): libera só o domínio configurado.
const publicCors = cors({ origin: LANDING_PAGE_ORIGIN === '*' ? true : LANDING_PAGE_ORIGIN });
// Endpoints do CRM: liberado para qualquer origem (o CRM roda como artifact,
// origem variável), protegido por x-api-key em vez de CORS restritivo.
const crmCors = cors({ origin: true });

// ---------- rate limit simples em memória (por IP) ----------
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateMap.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX;
}

function normalizePhone(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\D/g, '');
}
function s(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t.slice(0, 500) : null;
}

function requireCrmKey(req, res, next) {
  if (!CRM_API_KEY) {
    return res.status(500).json({ success: false, message: 'CRM_API_KEY não configurada no servidor.' });
  }
  if (req.headers['x-api-key'] !== CRM_API_KEY) {
    return res.status(401).json({ success: false, message: 'unauthorized' });
  }
  next();
}

// ============================================================
// GET /health — usado pelo Render e por um pinger externo (ex: UptimeRobot)
// para manter o serviço acordado no plano gratuito.
// ============================================================
app.get('/health', (req, res) => res.json({ ok: true, db: db.isUsingMongo() ? 'mongo' : 'memory', time: new Date().toISOString() }));

// ============================================================
// POST /api/leads — endpoint público, chamado pela landing page
// ============================================================
app.post('/api/leads', publicCors, async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ success: false, message: 'rate_limited' });

  if (LEAD_WEBHOOK_SECRET) {
    if (req.headers['x-webhook-secret'] !== LEAD_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, message: 'unauthorized' });
    }
  }

  const body = req.body || {};
  // honeypot
  if (s(body.website) || s(body._hp)) return res.status(200).json({ success: true, lead_id: null, message: 'ok' });

  const name = s(body.name);
  const phoneRaw = s(body.phone);
  const phoneNormalized = normalizePhone(phoneRaw);

  if (!name) return res.status(400).json({ success: false, message: "Campo 'name' é obrigatório." });
  if (!phoneNormalized || phoneNormalized.length < 8) {
    return res.status(400).json({ success: false, message: "Campo 'phone' é obrigatório e precisa ser um telefone válido." });
  }
  const email = s(body.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'E-mail inválido.' });
  }

  const payload = {
    name, phone: phoneRaw, whatsapp: phoneRaw, phoneNormalized, email,
    interest: s(body.interest),
    source: s(body.source), platform: s(body.source),
    utmSource: s(body.utm_source), utmMedium: s(body.utm_medium), utmCampaign: s(body.utm_campaign),
    utmContent: s(body.utm_content), utmTerm: s(body.utm_term), sourceUrl: s(body.source_url),
  };

  try {
    const existing = await db.findLeadByPhoneNormalized(phoneNormalized);
    if (existing) {
      await db.updateLead(existing.id, {
        email: email ?? existing.email,
        interest: payload.interest ?? existing.interest,
        utmTerm: payload.utmTerm ?? existing.utmTerm,
        sourceUrl: payload.sourceUrl ?? existing.sourceUrl,
      });
      await db.createOrigin({ leadId: existing.id, ...payload, rawPayload: body });
      await db.createEvent({
        leadId: existing.id, eventType: 'new_interaction', field: 'origem',
        beforeValue: null, afterValue: payload.platform || payload.source || 'origem desconhecida',
        actor: 'Landing Page (api/leads)',
      });
      return res.status(200).json({ success: true, lead_id: existing.id, message: 'Lead já existia — nova interação registrada.' });
    }

    const aiTriggerAt = new Date(Date.now() + 2 * 60 * 1000);
    const created = await db.createLead({
      ...payload, status: 'Novo', temperature: 'Não classificado',
      aiTriggerAt, conversationStatus: 'nenhuma',
    });
    await db.createOrigin({ leadId: created.id, ...payload, rawPayload: body });
    await db.createEvent({
      leadId: created.id, eventType: 'lead_created', field: 'status',
      beforeValue: null, afterValue: 'Novo', actor: 'Landing Page (api/leads)',
    });

    return res.status(201).json({ success: true, lead_id: created.id, message: 'Lead criado. Acompanhamento automático agendado em 2 minutos.' });
  } catch (err) {
    console.error('[POST /api/leads]', err);
    return res.status(500).json({ success: false, message: 'internal_error' });
  }
});

// ============================================================
// Endpoints do CRM (ghex-crm.html) — protegidos por x-api-key
// ============================================================
app.get('/api/crm/leads', crmCors, requireCrmKey, async (req, res) => {
  const leads = await db.listLeads();
  res.json({ success: true, leads });
});

app.get('/api/crm/leads/:id', crmCors, requireCrmKey, async (req, res) => {
  const lead = await db.findLeadById(req.params.id);
  if (!lead) return res.status(404).json({ success: false, message: 'not_found' });
  res.json({ success: true, lead });
});

app.patch('/api/crm/leads/:id', crmCors, requireCrmKey, async (req, res) => {
  const before = await db.findLeadById(req.params.id);
  if (!before) return res.status(404).json({ success: false, message: 'not_found' });
  const allowed = ['status', 'temperature', 'broker', 'interest', 'note'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  const updated = await db.updateLead(req.params.id, patch);
  if (req.body.eventMeta) {
    const { type, field, before: b, after } = req.body.eventMeta;
    await db.createEvent({ leadId: req.params.id, eventType: type, field, beforeValue: String(b ?? ''), afterValue: String(after ?? ''), actor: req.body.actor || 'CRM' });
  }
  res.json({ success: true, lead: updated });
});

app.post('/api/crm/leads', crmCors, requireCrmKey, async (req, res) => {
  const b = req.body || {};
  const phoneNormalized = normalizePhone(b.phone || b.whatsapp);
  const created = await db.createLead({
    name: b.name, phone: b.phone, whatsapp: b.whatsapp, phoneNormalized,
    email: b.email, interest: b.interest, source: b.source, platform: b.platform,
    status: 'Novo', temperature: 'Não classificado',
  });
  await db.createEvent({ leadId: created.id, eventType: 'lead_created', field: 'status', beforeValue: null, afterValue: 'Novo', actor: req.body.actor || 'CRM' });
  res.status(201).json({ success: true, lead: created });
});

app.get('/api/crm/leads/:id/events', crmCors, requireCrmKey, async (req, res) => {
  const events = await db.listEvents(req.params.id);
  res.json({ success: true, events });
});

app.get('/api/crm/leads/:id/messages', crmCors, requireCrmKey, async (req, res) => {
  const messages = await db.listMessages(req.params.id);
  res.json({ success: true, messages });
});

// Dispara o job manualmente (útil para testar sem esperar o intervalo) —
// também protegido por x-api-key, já que qualquer um que o chame força
// o envio real de WhatsApp para leads vencidos.
app.post('/api/crm/dispatch-now', crmCors, requireCrmKey, async (req, res) => {
  const result = await dispatchDueLeads();
  res.json({ success: true, result });
});

// ============================================================
// WhatsApp — webhook inbound (mensagens recebidas do cliente)
// ============================================================
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN && WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('forbidden');
});

app.post('/api/whatsapp/webhook', async (req, res) => {
  const parsed = parseInboundWhatsAppPayload(req.body);
  if (!parsed) return res.json({ ok: true, ignored: true });

  const phoneDigits = normalizePhone(parsed.phone);
  const lead = await db.findLeadByPhoneNormalized(phoneDigits);
  if (!lead) {
    console.warn('[whatsapp webhook] mensagem de número sem lead:', parsed.phone);
    return res.json({ ok: true, unknown_sender: true });
  }

  const now = new Date();
  await db.createMessage({
    leadId: lead.id, telefone: parsed.phone, remetente: 'cliente',
    conteudo: parsed.content, tipo: 'texto', origem: 'whatsapp', status: 'recebido',
    providerMessageId: parsed.providerMessageId,
  });
  await db.updateLead(lead.id, {
    lastMessageAt: now,
    conversationStatus: 'respondeu',
    firstContactAt: lead.firstContactAt || now,
  });
  await db.createEvent({
    leadId: lead.id, eventType: 'customer_replied', field: 'conversation_status',
    beforeValue: null, afterValue: 'respondeu', actor: 'Cliente (WhatsApp)',
  });

  res.json({ ok: true });
});

// ============================================================
// Start
// ============================================================
async function start() {
  await db.connect();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[server] G-HEX backend rodando na porta ${port}.`);
    startDispatchLoop(30_000);
  });
}

start().catch(err => {
  console.error('[server] falha ao iniciar', err);
  process.exit(1);
});

module.exports = app;
