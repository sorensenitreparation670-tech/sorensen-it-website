# Square-opsætning — Sørensen IT

Kort guide til at få kortbetaling til at virke i `checkout.html`.
Alt hentes på **https://app.squareup.com/**

---

## 1. Hent dine nøgler

På app.squareup.com → **Developer** → vælg (eller opret) din app:

| Værdi | Hvor | Hvor skal den hen |
|---|---|---|
| **Application ID** (`sq0idp-…`) | Credentials | `checkout.html` → `CONFIG.square.applicationId` |
| **Location ID** (fx `L56T…`) | Locations | `checkout.html` → `CONFIG.square.locationId` **og** `.env` → `SQUARE_LOCATION_ID` |
| **Access Token** (`EAAA…`) | Credentials | **kun** `.env` → `SQUARE_ACCESS_TOKEN` |

> ⚠️ Access token må **aldrig** stå i en HTML-fil — den skal kun ligge på serveren.
> `sq0idp-…` er Application ID'et, ikke et access token.

Begge sæt findes i to udgaver: **Sandbox** (test) og **Production** (rigtige penge).
Brug sandbox først — sæt `SQUARE_ENV=sandbox` i `.env` og
`environment:'sandbox'` i `checkout.html`.

## 2. Sæt serveren op

```bash
cp .env.example .env      # udfyld dine værdier
npm install
npm start                 # → http://localhost:3000
```

Serveren skriver ved opstart om Square er klar:

```
Square:     ✅ klar (production)
```

Er der noget galt, står der præcis hvad der mangler.

## 3. Test

`checkout.html` spørger selv serveren (`/api/status`), om kortbetaling er klar:

* **Server kører + nøgler OK** → kortfeltet fra Square vises, og "Betal …" trækker pengene.
* **Ingen server / manglende nøgler** → kortfanen låses automatisk, og
  MobilePay + bankoverførsel bliver valgt i stedet. Kunden ser aldrig en fejl.

Testkort i sandbox: `4111 1111 1111 1111`, udløb i fremtiden, CVV `111`, postnr. `8000`.

## 4. Apple Pay & Google Pay (valgfrit)

Knapperne dukker kun op, når de kan bruges.

* **Apple Pay:** Developer → **Apple Pay** → registrér dit domæne (kræver HTTPS).
* **Google Pay:** virker automatisk i Chrome, når siden kører på HTTPS.

Vil du slå dem fra: `wallets:false` i `CONFIG.square`.

## 5. Priser

Beløbet regnes altid ud **på serveren** ud fra `PRISER` i `server.js` — så kan en
pris ikke ændres i browseren, før der betales.

**Ændrer du en pris i `index.html`, så husk at rette den samme pris i `PRISER` i
`server.js`.** Tilføjer du en helt ny service, skal dens `id` også tilføjes der,
ellers afvises kortbetalingen med en besked om præcis hvilket id der mangler.

## 6. Kvitteringsmails

* **Til jer:** sendes via Web3Forms (nøglen står i `CONFIG.mail.web3formsKey`).
* **Til kunden:** sendes af serveren (`/api/kvittering`) via Gmail.
  Kræver `MAIL_USER` + et **app-kodeord** i `MAIL_PASS`
  (https://myaccount.google.com/apppasswords).

Alle gennemførte ordrer gemmes også i `ordrer.jsonl` ved siden af serveren.

## 7. Når I går live

- [ ] Production-nøgler i `.env`, `SQUARE_ENV=production`
- [ ] `environment:'production'` i `checkout.html`
- [ ] `SITE_URL` sat til jeres rigtige domæne (styrer CORS)
- [ ] HTTPS på domænet (Square kræver det)
- [ ] `.env` må **ikke** ligge i git — den er allerede i `.gitignore`
- [ ] Læg en prøveordre på 1 kr. og se den i app.squareup.com → **Transactions**
