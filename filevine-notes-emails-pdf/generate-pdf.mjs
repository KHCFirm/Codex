# Filevine Notes+Emails → PDF (Vercel)

This app serves a static `index.html` that calls a Node Serverless Function at `/api/generate-pdf?projectId=...`.  
The function authenticates to Filevine, fetches project **Notes + Emails (+ Comments)**, merges & de-dupes them, then streams a PDF download.

## Deploy (Vercel)
1. Import this repo into Vercel (root contains `index.html` and `api/`).
2. Set **Environment Variables** (Project Settings → Environment Variables):
   - `FILEVINE_CLIENT_ID`
   - `FILEVINE_CLIENT_SECRET`
   - *(optional)* `FILEVINE_ACCESS_TOKEN` – if set, the app skips token exchange and uses this bearer token directly.
   - *(optional)* `FILEVINE_SCOPE` – defaults to `email filevine.v2.api.* fv.api.gateway.access fv.auth.tenant.read openid tenant`
   - *(optional)* `FILEVINE_IDENTITY_BASE` – default `https://identity.filevine.com`
   - *(optional)* `FILEVINE_API_BASE` – default `https://api.filevineapp.com`
3. Visit the deployment URL, enter a Project ID, click **Generate PDF**.

### Local dev
```bash
npm i
vercel dev
# open http://localhost:3000
