# APS relay (Vercel)
Forwards requests from `jacsal-sync-cad` to `developer.api.autodesk.com`. Needed because Autodesk's API sits behind
Cloudflare and rejects Cloudflare Worker subrequests with HTTP 525. The function holds only the SHA-256 of the key (`RELAY_KEY_SHA256`, env or constant); the key itself is
the Cloudflare Secrets Store entry `APS_RELAY_KEY`. The Worker calls `GET|POST https://<relay>/api/aps?u=<encoded target url>`
with header `x-relay-key`. Only that one host is allowed. Bulk file bytes never pass through here (they go to S3 signed URLs directly).
