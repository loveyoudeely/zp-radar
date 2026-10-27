# ZP Radar

## Vercel map deployment

The map is a static site. Vercel builds it with `npm run build` and publishes `dist/`.
The build copies only the HTML pages and GeoJSON files, then generates `dist/config.js`
from environment variables.

Set these variables in Vercel under **Project Settings → Environment Variables**:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`)

The publishable/anon key is sent to browsers and is not a secret. Never use
`SUPABASE_SERVICE_ROLE_KEY` as the browser key. Protect database access with Supabase
Row Level Security policies.

For a local build, add the same two public variables to your ignored `.env` file and run:

```powershell
npm install
npm run build
npm run preview
```

Open the printed local URL. Do not edit or commit generated `dist/config.js`.

## Telegram workers

`parser.js` and `userbot.js` are long-running Telegram processes, not part of the static
Vercel deployment. Run them on a machine or worker service that supports persistent
processes, and configure their server-only environment variables there:

- `SUPABASE_SERVICE_ROLE_KEY`
- `GROQ_API_KEY`
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHAT_IDS` for `parser.js`
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_STRING_SESSION`, and
  `TELEGRAM_TARGET_CHANNEL` for `userbot.js`

Start locally with `npm run start:parser` or `npm run start:userbot`.

## GitHub

Create an empty repository on GitHub, then run these commands from the project folder:

```powershell
git init
git add .
git status
```

Before committing, confirm `.env`, `node_modules`, and `dist` are not staged. Then:

```powershell
git commit -m "Prepare ZP Radar for deployment"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Import the repository in Vercel and set the two public Supabase build variables above.

## Credential safety

The admin-page access code is embedded in client-side HTML and is not a secure
authentication mechanism. Use Supabase Auth and restrictive RLS policies before relying
on the admin page for access control.

The previous `userbot.js` contained a Telegram session string. Revoke that session from
Telegram's **Settings → Devices**, create a new session, and store it only in the
untracked `.env` file and the worker's secret environment configuration.
