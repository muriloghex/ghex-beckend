// ============================================================
// Camada de dados — MongoDB (Mongoose) com fallback em memória.
//
// Se MONGODB_URI não estiver definida, o servidor sobe mesmo assim,
// usando arrays em memória (dados somem ao reiniciar o processo) — serve
// para você testar o fluxo inteiro sem precisar criar o banco ainda.
// Em produção, SEMPRE defina MONGODB_URI (MongoDB Atlas, free tier M0).
// ============================================================

const mongoose = require('mongoose');

let useMongo = false;

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[db] MONGODB_URI não definida — rodando em modo MEMÓRIA (dados não persistem entre reinícios).');
    useMongo = false;
    return;
  }
  await mongoose.connect(uri);
  useMongo = true;
  console.log('[db] Conectado ao MongoDB.');
}

// ---------- Schemas (só usados quando useMongo === true) ----------
const LeadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: String,
  whatsapp: String,
  phoneNormalized: { type: String, index: true },
  email: String,
  interest: String,
  propertyId: String,
  status: { type: String, default: 'Novo' },
  temperature: { type: String, default: 'Não classificado' },
  broker: { type: String, default: 'Não atribuído' },
  source: String,
  platform: String,
  sourceUrl: String,
  utmSource: String,
  utmMedium: String,
  utmCampaign: String,
  utmContent: String,
  utmTerm: String,
  note: String,
  aiTriggerAt: Date,
  aiTriggeredAt: Date,
  firstContactAt: Date,
  lastMessageAt: Date,
  conversationStatus: { type: String, default: 'nenhuma' },
}, { timestamps: true });

const LeadOriginSchema = new mongoose.Schema({
  leadId: { type: mongoose.Schema.Types.ObjectId, index: true },
  source: String,
  platform: String,
  utmSource: String,
  utmMedium: String,
  utmCampaign: String,
  utmContent: String,
  utmTerm: String,
  sourceUrl: String,
  rawPayload: Object,
}, { timestamps: { createdAt: 'receivedAt', updatedAt: false } });

const LeadEventSchema = new mongoose.Schema({
  leadId: { type: mongoose.Schema.Types.ObjectId, index: true },
  eventType: String,
  field: String,
  beforeValue: String,
  afterValue: String,
  actor: String,
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

const MessageSchema = new mongoose.Schema({
  leadId: { type: mongoose.Schema.Types.ObjectId, index: true },
  telefone: String,
  remetente: { type: String, enum: ['ia', 'cliente', 'corretor', 'sistema'] },
  conteudo: String,
  tipo: { type: String, default: 'texto' },
  origem: { type: String, default: 'whatsapp' },
  status: { type: String, default: 'enviado' },
  providerMessageId: String,
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

const Lead = mongoose.model('Lead', LeadSchema);
const LeadOrigin = mongoose.model('LeadOrigin', LeadOriginSchema);
const LeadEvent = mongoose.model('LeadEvent', LeadEventSchema);
const Message = mongoose.model('Message', MessageSchema);

// ---------- Fallback em memória (mesma interface, sem Mongo) ----------
let mem = { leads: [], origins: [], events: [], messages: [] };
let memIdCounter = 1;
function memId() { return 'mem_' + (memIdCounter++); }

function toPublicLead(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return { ...o, id: String(o._id || o.id) };
}

// ---------- API pública da camada de dados (usada pelas rotas) ----------

async function createLead(fields) {
  if (useMongo) {
    const doc = await Lead.create(fields);
    return toPublicLead(doc);
  }
  const doc = { ...fields, _id: memId(), createdAt: new Date(), updatedAt: new Date() };
  mem.leads.unshift(doc);
  return toPublicLead(doc);
}

async function findLeadByPhoneNormalized(phoneNormalized) {
  if (useMongo) {
    const doc = await Lead.findOne({ phoneNormalized });
    return toPublicLead(doc);
  }
  const doc = mem.leads.find(l => l.phoneNormalized === phoneNormalized);
  return toPublicLead(doc);
}

async function findLeadById(id) {
  if (useMongo) {
    const doc = await Lead.findById(id).catch(() => null);
    return toPublicLead(doc);
  }
  const doc = mem.leads.find(l => String(l._id) === String(id));
  return toPublicLead(doc);
}

async function updateLead(id, patch) {
  if (useMongo) {
    const doc = await Lead.findByIdAndUpdate(id, patch, { new: true });
    return toPublicLead(doc);
  }
  const doc = mem.leads.find(l => String(l._id) === String(id));
  if (!doc) return null;
  Object.assign(doc, patch, { updatedAt: new Date() });
  return toPublicLead(doc);
}

async function listLeads() {
  if (useMongo) {
    const docs = await Lead.find().sort({ createdAt: -1 });
    return docs.map(toPublicLead);
  }
  return mem.leads
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(toPublicLead);
}

async function findDueLeads(nowDate, limit = 25) {
  if (useMongo) {
    const docs = await Lead.find({ aiTriggerAt: { $lte: nowDate }, aiTriggeredAt: null }).limit(limit);
    return docs.map(toPublicLead);
  }
  return mem.leads
    .filter(l => l.aiTriggerAt && new Date(l.aiTriggerAt) <= nowDate && !l.aiTriggeredAt)
    .slice(0, limit)
    .map(toPublicLead);
}

async function createOrigin(fields) {
  if (useMongo) { await LeadOrigin.create(fields); return; }
  mem.origins.unshift({ ...fields, _id: memId(), receivedAt: new Date() });
}

async function createEvent(fields) {
  if (useMongo) { await LeadEvent.create(fields); return; }
  mem.events.unshift({ ...fields, _id: memId(), createdAt: new Date() });
}

async function listEvents(leadId) {
  if (useMongo) {
    const docs = await LeadEvent.find({ leadId }).sort({ createdAt: -1 });
    return docs.map(toPublicLead);
  }
  return mem.events
    .filter(e => String(e.leadId) === String(leadId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(toPublicLead);
}

async function createMessage(fields) {
  if (useMongo) {
    const doc = await Message.create(fields);
    return toPublicLead(doc);
  }
  const doc = { ...fields, _id: memId(), createdAt: new Date() };
  mem.messages.push(doc);
  return toPublicLead(doc);
}

async function listMessages(leadId) {
  if (useMongo) {
    const docs = await Message.find({ leadId }).sort({ createdAt: 1 });
    return docs.map(toPublicLead);
  }
  return mem.messages
    .filter(m => String(m.leadId) === String(leadId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(toPublicLead);
}

async function countMessagesForLead(leadId) {
  if (useMongo) return Message.countDocuments({ leadId });
  return mem.messages.filter(m => String(m.leadId) === String(leadId)).length;
}

function isUsingMongo() { return useMongo; }

module.exports = {
  connect, isUsingMongo,
  createLead, findLeadByPhoneNormalized, findLeadById, updateLead, listLeads, findDueLeads,
  createOrigin, createEvent, listEvents,
  createMessage, listMessages, countMessagesForLead,
};
