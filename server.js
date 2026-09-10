// server.js
// Backend de paiement pour Viral Hook Generator — intégration PayDunya
//
// Ce serveur fait deux choses à la fois :
//  1. Il sert le site (le fichier dans public/index.html)
//  2. Il expose l'API de paiement PayDunya
// Les deux vivent donc sur UNE SEULE URL une fois déployé — pas besoin
// d'un hébergement séparé pour le site.
//
// Ce serveur est le SEUL endroit où les clés PayDunya doivent exister.
// Ne colle jamais ces clés dans le fichier HTML du site : elles doivent
// rester ici, chargées depuis des variables d'environnement (.env).
//
// Installation : npm install
// Lancement    : npm start
//
// Variables d'environnement requises (voir .env.example) :
//   PAYDUNYA_MASTER_KEY
//   PAYDUNYA_PRIVATE_KEY
//   PAYDUNYA_TOKEN
//   PAYDUNYA_MODE        ("test" ou "live")
//   PUBLIC_APP_URL       (l'URL publique de CE serveur une fois déployé,
//                         ex: https://viral-hook-generator.onrender.com)
//   PORT                 (optionnel — Render la fournit automatiquement)

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sert le site (public/index.html = le fichier Viral Hook Generator) sur ce
// même serveur. Ainsi, une seule URL déployée sert à la fois le site et
// l'API : pas besoin de gérer deux hébergements séparés.
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Config ----------
const PAYDUNYA_BASE = process.env.PAYDUNYA_MODE === 'live'
  ? 'https://app.paydunya.com/api/v1'
  : 'https://app.paydunya.com/sandbox-api/v1';

// Tarifs. "amount" est dans la devise réellement configurée sur ton compte
// PayDunya (par défaut XOF). Si ton compte facture en XOF, remplace ces
// montants par l'équivalent en XOF de 9€ / 20€ (vérifie le taux du jour,
// ou fixe un montant XOF rond côté business). Si PayDunya EUR est activé
// sur ton compte, laisse tel quel.
const PLANS = {
  createur: { label: 'Créateur', amount: 9, description: 'Viral Hook Generator — Formule Créateur (1 mois)' },
  studio:   { label: 'Studio',   amount: 20, description: 'Viral Hook Generator — Formule Studio (1 mois)' }
};

const UNLOCK_DAYS = 30;

// ---------- Stockage minimal (fichier JSON local) ----------
// Pour un usage réel avec plusieurs clients simultanés, remplace ceci par
// une vraie base de données (Postgres, SQLite, etc.). Ce fichier suffit
// pour démarrer et tester le flux de bout en bout.
const DB_FILE = path.join(__dirname, 'unlocks.json');
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Inscriptions (comptes) — stockées uniquement côté serveur, jamais dans le
// storage partagé de l'artefact, pour que les emails ne soient pas lisibles
// par n'importe quel visiteur du site depuis son navigateur.
const SIGNUPS_FILE = path.join(__dirname, 'signups.json');
function readSignups() {
  try { return JSON.parse(fs.readFileSync(SIGNUPS_FILE, 'utf8')); }
  catch (e) { return []; }
}
function writeSignups(list) {
  fs.writeFileSync(SIGNUPS_FILE, JSON.stringify(list, null, 2));
}

function paydunyaHeaders() {
  return {
    'Content-Type': 'application/json',
    'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
    'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
    'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN
  };
}

// ---------- 0) Inscription ----------
// Le site appelle cette route avant de laisser quelqu'un utiliser l'outil.
app.post('/api/register', (req, res) => {
  try {
    const { name, email, customerId } = req.body || {};
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanName = (name || '').trim();

    if (!cleanName || !cleanEmail || !cleanEmail.includes('@')) {
      return res.status(400).json({ error: 'Nom et email valides requis' });
    }

    const signups = readSignups();
    const existing = signups.find(s => s.email === cleanEmail);
    if (existing) {
      existing.lastSeenAt = Date.now();
      if (customerId) existing.customerId = customerId;
      writeSignups(signups);
      return res.json({ ok: true, alreadyRegistered: true, count: signups.length });
    }

    signups.push({
      name: cleanName,
      email: cleanEmail,
      customerId: customerId || null,
      registeredAt: Date.now()
    });
    writeSignups(signups);
    res.json({ ok: true, alreadyRegistered: false, count: signups.length });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Erreur serveur lors de l\'inscription' });
  }
});

// Compteur public — safe à afficher à tout le monde, ne révèle aucune
// donnée personnelle, juste un nombre.
app.get('/api/signup-count', (req, res) => {
  res.json({ count: readSignups().length });
});

// Liste privée — protégée par une clé simple (ADMIN_KEY dans les variables
// d'environnement). Toi seul, qui connais cette clé, peux voir les noms et
// emails. N'importe qui d'autre obtient une erreur 401.
app.get('/api/admin/signups', (req, res) => {
  const key = req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  res.json({ signups: readSignups() });
});

// ---------- 1) Créer une facture PayDunya ----------
// Le site appelle cette route quand l'utilisateur choisit une offre.
// On retourne l'URL de paiement hébergée par PayDunya ; le navigateur
// doit y être redirigé (window.location.href = checkoutUrl).
app.post('/api/create-invoice', async (req, res) => {
  const { plan, customerId } = req.body || {};
  const chosen = PLANS[plan];
  if (!chosen) return res.status(400).json({ error: 'Formule inconnue' });
  if (!customerId) return res.status(400).json({ error: 'customerId manquant' });

  const payload = {
    invoice: {
      total_amount: chosen.amount,
      description: chosen.description
    },
    store: {
      name: 'Viral Hook Generator'
    },
    actions: {
      cancel_url: `${process.env.PUBLIC_APP_URL}/?payment=cancel`,
      return_url: `${process.env.PUBLIC_APP_URL}/?payment=success&customerId=${encodeURIComponent(customerId)}`,
      callback_url: `${process.env.PUBLIC_APP_URL}/api/paydunya/ipn`
    },
    custom_data: { customerId, plan }
  };

  try {
    const r = await fetch(`${PAYDUNYA_BASE}/checkout-invoice/create`, {
      method: 'POST',
      headers: paydunyaHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await r.json();

    if (data.response_code !== '00') {
      console.error('PayDunya a refusé la création de facture:', JSON.stringify(data));
      return res.status(400).json({ error: data.response_text || 'Erreur PayDunya (code ' + data.response_code + ')' });
    }

    const db = readDB();
    db[data.token] = {
      customerId,
      plan,
      status: 'pending',
      createdAt: Date.now()
    };
    writeDB(db);

    res.json({ checkoutUrl: data.response_text, token: data.token });
  } catch (err) {
    console.error('create-invoice error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---------- 2) IPN — PayDunya confirme le paiement ----------
// PayDunya appelle CETTE route côté serveur (pas le navigateur du client)
// une fois le paiement effectué. C'est la seule source de vérité : ne
// jamais débloquer l'accès uniquement parce que le navigateur est revenu
// sur return_url, un utilisateur pourrait fabriquer cette URL lui-même.
app.post('/api/paydunya/ipn', async (req, res) => {
  const invoiceToken = req.body?.data?.invoice?.token || req.body?.invoice_token || req.body?.token;
  if (!invoiceToken) return res.status(400).send('token manquant');

  try {
    const r = await fetch(`${PAYDUNYA_BASE}/checkout-invoice/confirm/${invoiceToken}`, {
      headers: paydunyaHeaders()
    });
    const data = await r.json();

    const db = readDB();
    const record = db[invoiceToken];

    const isPaid = data.response_code === '00' &&
      data.invoice && (data.invoice.status === 'completed' || data.status === 'completed');

    if (isPaid && record) {
      record.status = 'paid';
      record.unlockExpires = Date.now() + UNLOCK_DAYS * 24 * 60 * 60 * 1000;
      db[invoiceToken] = record;
      writeDB(db);
    }

    res.status(200).send('ok'); // toujours répondre 200 pour accuser réception à PayDunya
  } catch (err) {
    console.error('ipn error:', err);
    res.status(200).send('ok');
  }
});

// ---------- 3) Le site vérifie l'accès ----------
app.get('/api/check-access', (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.status(400).json({ error: 'customerId manquant' });

  const db = readDB();
  const entry = Object.values(db)
    .filter(r => r.customerId === customerId && r.status === 'paid')
    .sort((a, b) => (b.unlockExpires || 0) - (a.unlockExpires || 0))[0];

  if (entry && entry.unlockExpires > Date.now()) {
    return res.json({ unlocked: true, until: entry.unlockExpires, plan: entry.plan });
  }
  res.json({ unlocked: false });
});

// ---------- Génération IA (hooks + scripts) ----------
// Le site n'appelle JAMAIS l'API de génération directement : ça exposerait
// une clé API dans le navigateur. Il passe par cette route, qui détient
// la clé côté serveur uniquement.
// Utilise Google Gemini (gratuit, sans carte bancaire) plutôt qu'Anthropic.
app.post('/api/claude-generate', async (req, res) => {
  const { system, prompt, maxTokens } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt manquant' });
  if (!process.env.GEMINI_API_KEY) {
    console.error('claude-generate: GEMINI_API_KEY absente. Variables présentes:', Object.keys(process.env).filter(k => k.includes('GEMINI') || k.includes('API')));
    return res.status(500).json({ error: "Clé API Gemini manquante côté serveur (GEMINI_API_KEY)." });
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          generationConfig: { maxOutputTokens: maxTokens || 1000 }
        })
      }
    );
    const data = await r.json();
    if (!r.ok) {
      console.error('claude-generate error:', JSON.stringify(data));
      return res.status(r.status).json({ error: data.error?.message || 'Erreur API Gemini' });
    }
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('claude-generate: réponse inattendue:', JSON.stringify(data));
      return res.status(500).json({ error: 'Aucun contenu retourné par Gemini' });
    }
    res.json({ text });
  } catch (err) {
    console.error('claude-generate error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, mode: process.env.PAYDUNYA_MODE || 'test' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend PayDunya en écoute sur le port ${PORT} (mode: ${process.env.PAYDUNYA_MODE || 'test'})`);
});
