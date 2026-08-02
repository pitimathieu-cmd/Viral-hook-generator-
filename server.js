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

function paydunyaHeaders() {
  return {
    'Content-Type': 'application/json',
    'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
    'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
    'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN
  };
}

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
      return res.status(400).json({ error: data.response_text || 'Erreur PayDunya' });
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

app.get('/health', (req, res) => res.json({ ok: true, mode: process.env.PAYDUNYA_MODE || 'test' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend PayDunya en écoute sur le port ${PORT} (mode: ${process.env.PAYDUNYA_MODE || 'test'})`);
});
