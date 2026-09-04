/* Sørensen IT — betalings- og kvitteringsserver
   Node 18+ · npm i express cors nodemailer */
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.SITE_URL || '*' }));

const SQUARE_BASE = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

app.post('/api/betaling', async (req, res) => {
  const { sourceId, belob, valuta = 'DKK', ordre } = req.body || {};
  if (!sourceId || !Number.isFinite(belob) || belob <= 0) {
    return res.status(400).json({ success: false, fejl: 'Ugyldig betalingsanmodning.' });
  }
  try {
    const svar = await fetch(`${SQUARE_BASE}/v2/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: ordre?.id || randomUUID(),
        amount_money: { amount: Math.round(belob * 100), currency: valuta },
        location_id: process.env.SQUARE_LOCATION_ID,
        buyer_email_address: ordre?.kunde?.email,
        reference_id: ordre?.id,
        note: `Sørensen IT ${ordre?.id || ''}`
      })
    });
    const data = await svar.json();
    if (!svar.ok) {
      console.error('Square-fejl:', JSON.stringify(data.errors, null, 2));
      return res.status(400).json({ success: false, fejl: data.errors?.[0]?.detail || 'Betalingen blev afvist.' });
    }
    res.json({ success: true, paymentId: data.payment.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, fejl: 'Serverfejl — prøv igen om lidt.' });
  }
});

app.post('/api/kvittering', async (req, res) => {
  const { til, emne, html } = req.body || {};
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

app.listen(process.env.PORT || 3000, () => console.log('Serveren kører ✅'));