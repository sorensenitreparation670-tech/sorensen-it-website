/* ══════════════════════════════════════════════════════════════════════
   Sørensen IT — betalings- og kvitteringsserver
   Node 18+ ·  npm install  ·  npm start

   Opsætning på https://app.squareup.com/
     1) Developer → din app → Credentials
          · Application ID  (sq0idp-…)  → checkout.html → CONFIG.square.applicationId
          · Access Token    (EAAA…)     → .env → SQUARE_ACCESS_TOKEN   (HEMMELIG!)
     2) Developer → din app → Locations
          · Location ID     (fx L56T…)  → .env → SQUARE_LOCATION_ID
                                        → checkout.html → CONFIG.square.locationId
     3) Vil du bruge Apple Pay: Developer → Apple Pay → registrér dit domæne.
     4) Test først med SQUARE_ENV=sandbox og sandbox-nøglerne.
   ══════════════════════════════════════════════════════════════════════ */
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Læs .env ind (virker på alle Node 18+ uden ekstra pakker) */
(function laesEnv(){
  try{
    for (const linje of readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = linje.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const vaerdi = m[2].trim().replace(/^["'](.*)["']$/, '$1');
      if (process.env[m[1]] === undefined) process.env[m[1]] = vaerdi;
    }
  }catch{ /* ingen .env — så bruges systemets miljøvariabler */ }
})();

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.SITE_URL || '*' }));

/* ══════════════ SIKKERHEDS-HEADERS ══════════════
   Sættes på hvert svar. CSP'en matcher den i index.html/checkout.html —
   retter du i den ene, så ret i den anden.                              */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://*.squarecdn.com https://pay.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://api.qrserver.com",
  "media-src 'self'",
  "connect-src 'self' https://api.web3forms.com https://*.squareup.com https://*.squareupsandbox.com https://*.squarecdn.com https://pay.google.com",
  "frame-src https://*.squarecdn.com https://*.squareup.com https://*.squareupsandbox.com https://pay.google.com",
  "form-action 'self' https://api.web3forms.com",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "upgrade-insecure-requests"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');          /* ingen MIME-gætteri  */
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');              /* mod klikjacking     */
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(self), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  /* HSTS kun over HTTPS — ellers kan man låse sig selv ude lokalt */
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* .env og andre skjulte filer må aldrig serveres */
app.use((req, res, next) => {
  if (/(^|\/)\.(env|git|htaccess)/i.test(req.path) || /\.(jsonl|log)$/i.test(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

/* Hele websitet serveres herfra, så checkout.html selv finder /api/betaling */
app.use(express.static(__dirname, {
  extensions: ['html'],
  dotfiles: 'deny',
  setHeaders(res, filePath) {
    if (/\.(png|jpg|jpeg|webp|svg|ico|woff2?|mp4)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');   /* 7 dage */
    } else {
      res.setHeader('Cache-Control', 'no-cache');                 /* HTML skal altid være frisk */
    }
  }
}));

const SQUARE_BASE = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';

const TOKEN    = (process.env.SQUARE_ACCESS_TOKEN || '').trim();
const LOCATION = (process.env.SQUARE_LOCATION_ID  || '').trim();

/* Et access token starter med EAAA… — sq0idp-… er Application ID'et og virker ikke her */
const TOKEN_OK   = !!TOKEN && !TOKEN.startsWith('sq0idp-') && !TOKEN.startsWith('sq0idb-');
const SQUARE_OK  = TOKEN_OK && !!LOCATION;
const MAIL_OK    = !!process.env.MAIL_USER && !!process.env.MAIL_PASS &&
                   !/^dit_|^din_/i.test(process.env.MAIL_PASS || '');

/* ══════════════ PRISLISTE — hold den synkroniseret med index.html (SVCS) ══════════════
   Beløbet der trækkes, regnes ALTID ud her på serveren. Så kan en pris ikke
   ændres i browseren, før der betales.                                              */
const PRISER = {
  1:399, 2:1199, 3:249, 4:299, 5:249, 6:149, 7:149,
  8:199, 9:149, 10:149, 11:199, 12:199, 13:199, 14:99
};
const EXPRESS_PRIS = 100;
const RABATKODER = { SORENSEN10:10, VELKOMMEN:15, STUDENT20:20 };

function beregnTotal(ordre) {
  const varer = Array.isArray(ordre?.varer) ? ordre.varer : [];
  if (!varer.length) return { fejl: 'Ordren indeholder ingen varer.' };

  let sum = 0;
  for (const v of varer) {
    const pris = PRISER[v?.id];
    if (pris === undefined) {
      return { fejl: `Prisen kunne ikke bekræftes for "${v?.navn || 'ukendt vare'}". `
                   + `Tilføj vare-id ${v?.id} i PRISER i server.js.` };
    }
    const antal = Math.min(20, Math.max(1, parseInt(v?.antal, 10) || 1));
    sum += pris * antal;
  }

  const procent = RABATKODER[String(ordre?.rabatKode || '').toUpperCase()] || 0;
  const rabat = Math.round(sum * (procent / 100));
  const express = ordre?.express ? EXPRESS_PRIS : 0;
  return { total: Math.max(0, sum - rabat + express) };
}

/* ══════════════ Simpel beskyttelse mod kort-afprøvning ══════════════ */
const forsoeg = new Map();                       /* ip → [tidsstempler] */
function forMange(ip) {
  const nu = Date.now(), vindue = 10 * 60 * 1000, graense = 12;
  const liste = (forsoeg.get(ip) || []).filter(t => nu - t < vindue);
  liste.push(nu);
  forsoeg.set(ip, liste);
  if (forsoeg.size > 5000) forsoeg.clear();
  return liste.length > graense;
}

/* ══════════════ Danske fejlbeskeder fra Square ══════════════ */
const FEJLTEKST = {
  CARD_DECLINED:            'Kortet blev afvist af din bank. Prøv et andet kort, eller betal med MobilePay.',
  GENERIC_DECLINE:          'Betalingen blev afvist af din bank. Prøv et andet kort, eller betal med MobilePay.',
  INSUFFICIENT_FUNDS:       'Der er ikke dækning på kortet.',
  CVV_FAILURE:              'Kontrolcifrene (CVV) er forkerte.',
  VERIFY_CVV_FAILURE:       'Kontrolcifrene (CVV) er forkerte.',
  ADDRESS_VERIFICATION_FAILURE: 'Adressen matcher ikke kortet. Tjek postnummer og adresse.',
  INVALID_EXPIRATION:       'Udløbsdatoen er forkert.',
  CARD_EXPIRED:             'Kortet er udløbet.',
  EXPIRATION_FAILURE:       'Kortet er udløbet.',
  PAN_FAILURE:              'Kortnummeret ser ikke rigtigt ud.',
  CARD_NOT_SUPPORTED:       'Korttypen understøttes ikke. Prøv et andet kort eller MobilePay.',
  INVALID_CARD:             'Kortoplysningerne kunne ikke godkendes.',
  CARD_TOKEN_EXPIRED:       'Betalingen tog for lang tid. Indtast kortet igen.',
  CARD_TOKEN_USED:          'Betalingen er allerede gennemført.',
  VERIFY_AVS_FAILURE:       'Adressen kunne ikke bekræftes af banken.',
  PAYMENT_LIMIT_EXCEEDED:   'Beløbet overskrider kortets grænse.'
};
const daFejl = e => FEJLTEKST[e?.code] || e?.detail || 'Betalingen kunne ikke gennemføres.';

/* ══════════════ Status — checkout.html spørger her, før kortfeltet vises ══════════════ */
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    square: SQUARE_OK,
    kvittering: MAIL_OK,
    env: process.env.SQUARE_ENV === 'sandbox' ? 'sandbox' : 'production'
  });
});

/* ══════════════ Betaling ══════════════ */
app.post('/api/betaling', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

  if (!SQUARE_OK) {
    return res.status(503).json({
      success: false,
      fejl: 'Kortbetaling er ikke aktiveret på serveren endnu. Vælg MobilePay eller bankoverførsel.'
    });
  }
  if (forMange(ip)) {
    return res.status(429).json({ success: false, fejl: 'For mange forsøg. Vent 10 minutter, eller ring til os på 93 86 92 67.' });
  }

  const { sourceId, verificationToken, valuta = 'DKK', ordre } = req.body || {};
  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ success: false, fejl: 'Betalingen mangler kortoplysninger.' });
  }

  const beregnet = beregnTotal(ordre);
  if (beregnet.fejl) return res.status(400).json({ success: false, fejl: beregnet.fejl });
  const belob = beregnet.total;
  if (!Number.isFinite(belob) || belob <= 0) {
    return res.status(400).json({ success: false, fejl: 'Ugyldigt beløb.' });
  }

  try {
    const svar = await fetch(`${SQUARE_BASE}/v2/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': SQUARE_VERSION,
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source_id: sourceId,
        ...(verificationToken ? { verification_token: verificationToken } : {}),
        idempotency_key: (ordre?.id || randomUUID()).slice(0, 45),
        amount_money: { amount: Math.round(belob * 100), currency: valuta },
        location_id: LOCATION,
        buyer_email_address: ordre?.kunde?.email,
        reference_id: (ordre?.id || '').slice(0, 40),
        note: `Sørensen IT ${ordre?.id || ''}`.slice(0, 500),
        ...(ordre?.kunde?.post ? {
          billing_address: {
            address_line_1: ordre.kunde.adresse || '',
            locality: ordre.kunde.by || '',
            postal_code: ordre.kunde.post || '',
            country: 'DK'
          }
        } : {})
      })
    });

    const data = await svar.json();
    if (!svar.ok) {
      console.error('Square-fejl:', JSON.stringify(data.errors, null, 2));
      return res.status(400).json({ success: false, fejl: daFejl(data.errors?.[0]) });
    }

    await gemOrdre({ ...ordre, total: belob, status: 'Betalt', betalingsId: data.payment?.id });
    res.json({
      success: true,
      paymentId: data.payment?.id,
      receiptUrl: data.payment?.receipt_url,
      total: belob
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, fejl: 'Serverfejl — prøv igen om lidt, eller ring på 93 86 92 67.' });
  }
});

/* ══════════════ Kvitteringsmail til kunden ══════════════ */
const mailer = MAIL_OK ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
}) : null;

app.post('/api/kvittering', async (req, res) => {
  const { til, emne, html } = req.body || {};
  if (!mailer) return res.status(503).json({ success: false, fejl: 'Mailopsætningen mangler.' });
  if (!til || !html) return res.status(400).json({ success: false });
  try {
    await mailer.sendMail({
      from: `"Sørensen IT & Reparation" <${process.env.MAIL_USER}>`,
      to: til,
      bcc: process.env.MAIL_USER,
      subject: emne || 'Tak for din ordre hos Sørensen IT',
      html
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/* ══════════════ Ordrelog (ordrer.jsonl) ══════════════ */
async function gemOrdre(ordre) {
  try {
    await appendFile(path.join(__dirname, 'ordrer.jsonl'),
      JSON.stringify({ ...ordre, gemt: new Date().toISOString() }) + '\n', 'utf8');
  } catch (err) {
    console.error('Kunne ikke gemme ordren:', err.message);
  }
}

/* ══════════════ Start ══════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Sørensen IT — serveren kører på http://localhost:${PORT}  ✅`);
  console.log(`  Square:     ${SQUARE_OK ? '✅ klar (' + (process.env.SQUARE_ENV === 'sandbox' ? 'sandbox' : 'production') + ')' : '❌ ikke aktiv'}`);
  if (!TOKEN_OK && TOKEN.startsWith('sq0idp-')) {
    console.log('  ⚠️  SQUARE_ACCESS_TOKEN i .env ser ud til at være dit Application ID (sq0idp-…).');
    console.log('      Hent det rigtige access token (EAAA…) på app.squareup.com → Developer → Credentials.');
  } else if (!TOKEN_OK) {
    console.log('  ⚠️  SQUARE_ACCESS_TOKEN mangler i .env — kortbetaling er slået fra.');
  }
  if (!LOCATION) console.log('  ⚠️  SQUARE_LOCATION_ID mangler i .env.');
  console.log(`  Kvitteringsmail: ${MAIL_OK ? '✅ klar' : '❌ MAIL_USER/MAIL_PASS mangler'}\n`);
});
