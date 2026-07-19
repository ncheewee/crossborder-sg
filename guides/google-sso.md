# Google SSO setup

CrossBorder.sg uses Google Identity Services in the browser and verifies the
returned Google ID token in the Cloudflare Worker before serving API data.

## 1. Create the Google OAuth client

1. Open Google Cloud Console.
2. Go to APIs and Services, then Credentials.
3. Create an OAuth client ID.
4. Choose Web application.
5. Add this authorized JavaScript origin:

```text
https://ncheewee.github.io
```

6. No redirect URI is needed for the current popup button flow.
7. Copy the Web client ID.

## 2. Configure Cloudflare Worker

Set the Worker vars in `wrangler.api.toml` or with Cloudflare dashboard vars:

```text
GOOGLE_CLIENT_ID=<your-web-client-id>
AUTH_REQUIRED=true
```

Optional restrictions:

```text
ALLOWED_EMAILS=you@gmail.com,friend@gmail.com
ALLOWED_DOMAINS=company.com
```

Deploy the Worker:

```bash
npm run api:deploy
```

## 3. Build the public Pages bundle

Bake the same public client ID into the static app:

```bash
NEXT_PUBLIC_API_BASE=https://crossborder-sg-api.ncheewee.workers.dev \
NEXT_PUBLIC_GOOGLE_CLIENT_ID=<your-web-client-id> \
npm run build:pages
```

Then commit and push `docs/`.

## 4. Verify

1. Open `https://ncheewee.github.io/crossborder-sg/`.
2. Confirm the Google sign-in gate appears.
3. Sign in.
4. Confirm traffic cards load after sign-in.
5. Check Neon tables `auth_users` and `auth_events` for adoption tracking.

To test without locking the API, keep `AUTH_REQUIRED=false`; the frontend gate
can still be previewed if the Pages bundle has `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
