# Filevine Notes+Emails → PDF (Vercel app)

Minimal serverless app that prompts for a **Project ID**, then server-side:
- Authenticates with Filevine (PAT → access token)
- Looks up **User ID** and **Org ID** for gateway headers
- Pulls **Project Note List** + **Project Email List** (with pagination)
- Merges chronologically and streams a **PDF**

## Deploy (Vercel)
1. Create a new project in Vercel and import this folder.
2. Add environment variables:
   - `FILEVINE_CLIENT_ID`
   - `FILEVINE_CLIENT_SECRET`
   - `FILEVINE_PAT_TOKEN`
3. Visit your deployment URL and enter a Project ID.

> Do not expose secrets in client code. Keep them in Vercel env vars only.
