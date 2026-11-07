# Cane AI 2.0 — Premium public beta

Web app Node.js con:
- Registrazione e login email/password
- Accesso Google tramite Google Identity Services e verifica ID token lato server
- Chat AI con cronologia persistente per utente
- Memorie esplicite, consultabili ed eliminabili dall'utente
- Generazione immagini tramite OpenAI Images API
- Generazione video asincrona tramite API `/v1/videos` (Sora 2), polling e download
- Conversazione vocale realtime via WebRTC e credenziali effimere server-side
- Scacchi (mosse legali, avversario casuale), UNO semplificato e Forza 4

## Pubblicazione online (senza installare Node.js sul tuo computer)
Il progetto include `render.yaml` per il deploy su Render. Non posso creare io un URL pubblico senza accesso al tuo account di hosting e al repository, ma questa procedura evita di installare Node.js sul PC:
1. Carica questa cartella in un nuovo repository GitHub (non caricare mai `.env` o chiavi).
2. In Render scegli **New → Blueprint**, collega il repository e conferma il blueprint `render.yaml`.
3. Quando richiesto, inserisci `OPENAI_API_KEY` e `GOOGLE_CLIENT_ID`. Imposta `APP_ORIGIN` con l'URL HTTPS assegnato da Render.
4. In Google Cloud aggiungi quell'URL tra gli origini JavaScript autorizzati e usa lo stesso Client ID nel backend e in `public/config.json`.
5. Attendi il deploy e verifica `https://TUO-SITO/health` (deve rispondere `{"ok":true,...}`).

**Nota:** il servizio Render e il disco persistente possono avere un costo. Il blueprint è una configurazione di deploy, non un sito già pubblicato.

## Avvio locale
1. Installa Node.js 20 o superiore.
2. Estrai lo ZIP, apri un terminale nella cartella ed esegui `npm install`.
3. Copia `.env.example` in `.env`.
4. Imposta `JWT_SECRET` (almeno 32 caratteri) e `OPENAI_API_KEY`.
5. Per Google Login, crea un OAuth Client ID di tipo Web application in Google Cloud Console, configura gli origin autorizzati e inserisci il client ID in `public/config.json` e `GOOGLE_CLIENT_ID` in `.env`.
6. Esegui `npm start` e visita `http://localhost:3000`.

## Configurazione API
- `OPENAI_API_KEY`: abilita chat, immagini, video e voce. Le funzioni dipendono da accesso API, limiti, disponibilità del modello e fatturazione.
- `GOOGLE_CLIENT_ID`: deve corrispondere all'ID client configurato nel frontend e backend.
- `APP_ORIGIN`: origin canonico del sito.
- `DB_PATH`: percorso DB SQLite opzionale.

## Prima del lancio pubblico (obbligatorio)
Questo è un MVP tecnico, non ancora un servizio pronto per utenti pubblici su larga scala. Prima di renderlo pubblico:
- Sposta il DB su PostgreSQL gestito con backup, migrazioni e connessioni TLS.
- Usa cookie HttpOnly Secure SameSite o session store robusto invece di token localStorage.
- Aggiungi verifica email, reset password, cancellazione account, MFA opzionale e gestione sessioni.
- Applica rate limits per utente, quote e budget separati per chat, immagini, video e realtime; aggiungi protezioni anti-abuso.
- Implementa moderazione input/output, report, blocco utenti e policy contenuti.
- Aggiungi privacy policy, termini, consenso e processi GDPR (accesso, export, cancellazione, retention), cookie policy e policy minori.
- Configura HTTPS, CSP rigorosa, logging senza dati sensibili, monitoraggio e alert.
- Metti la generazione video in una coda job con retry, timeout, pulizia file e storage privato: la route di download attuale va verificata sul runtime hosting scelto.
- Rivedi UX/accessibilità, test cross-browser, test di carico e test di sicurezza.
- Migliora gli avversari: scacchi e UNO sono dimostrativi; Forza 4 usa mosse casuali e non implementa una strategia competitiva.
- Verifica le API e i modelli effettivamente abilitati per il tuo progetto prima del lancio.

## Note
Le chiavi API restano sul server. Il browser riceve solo un client secret temporaneo per la sessione realtime. Non caricare mai `.env` su GitHub.
