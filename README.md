# Gemini RAG exam (Vite + React)

Upload study files (PDF, DOCX, text, JSON, CSV). They are indexed with **Gemini File Search**, then the app generates a multiple-choice exam. Score history is stored in the browser.

## Local development

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`).
2. `npm install`
3. `npm run dev` — Vite serves the UI and starts the Express API for `/api` (see `vite.config.js`).

For API only: `npm run dev:api`.

## Deploy to Vercel

The repo is set up for **static Vite output** plus **Node serverless functions** in `/api` (see `vercel.json`).

1. Push the project to GitHub (or GitLab / Bitbucket).
2. In [Vercel](https://vercel.com), **Add New Project** → import the repo.
3. Under **Environment Variables**, add:
   - `GEMINI_API_KEY` — required  
   - `GEMINI_MODEL` — optional (defaults to `gemini-2.5-flash`)
4. Deploy with the default settings (Vercel will run `npm run build` and publish `dist/`).

The UI calls same-origin `/api/upload` and `/api/generate-exam`, which map to `api/upload.mjs` and `api/generate-exam.mjs`.

### Limits to be aware of

- **Duration**: File Search indexing can take longer than the **Hobby** serverless limit (10s). This project requests **120s** max duration for the upload and exam functions in `vercel.json`; that requires a **paid** Vercel plan where longer functions are allowed. If uploads time out, upgrade the plan or host the Express server elsewhere (e.g. Cloud Run, Railway) and point the frontend to that API URL.
- **Payload size**: Very large uploads may hit Vercel’s request body limits; use smaller files or a direct-to-storage upload flow if you outgrow it.

### Custom API URL (optional)

If the API is hosted separately, set `VITE_API_BASE` in Vercel to the origin (e.g. `https://api.example.com`) and adjust the frontend `fetch` calls to use that base URL (not implemented by default).


vercel remove testpdfquestions

1. Deployment Steps (How to Deploy)
Option A: Automated (GitHub/GitLab/Bitbucket)
This is the standard "architect" approach.

Connect Repo: Go to the Vercel Dashboard -> Add New -> Project.

Import: Select your repository (e.g., your ShopNow MERN project).

Configure: Vercel auto-detects frameworks (Next.js, Vite, etc.). Add your Environment Variables here.

Deploy: Click Deploy. Future git push commands to your main branch will trigger a fresh deployment automatically.

Option B: Command Line (CLI)
Best for quick tests or manual control.

Install: npm i -g vercel

Login: vercel login

Deploy: Run vercel in your project root.

This creates a Preview Deployment.

To deploy to Production, run: vercel --prod.

2. Removing Deployments & Projects
If you want to delete a specific version (deployment) or the entire project, follow these steps:

Removing a Single Deployment (The "Link")
Use this if you want to get rid of a specific preview URL but keep the project alive.

Dashboard: Go to your Project -> Deployments tab -> Click the three dots (...) next to a deployment -> Delete.

CLI: ```bash

Get the URL or ID first
vercel ls

Remove it
vercel rm
