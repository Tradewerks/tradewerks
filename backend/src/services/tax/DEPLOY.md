# Auto tax: deploy notes

1. **Ziptax plan.** The account must be on the Growth plan before the first paying tenant.
2. **Set env vars** in `backend/.env` (names as the code reads them):
   - `ZIPTAX_API_KEY`: the Ziptax key (`services/tax/index.ts`). With a key set and
     `TAX_RATE_PROVIDER` unset, the provider is `ziptax`.
   - `TAX_RATE_PROVIDER`: leave unset in production. `fixture` is refused when
     `NODE_ENV=production`, and any unknown value disables lookups.
   - `JWT_ACCESS_SECRET`: also signs the QuickBooks OAuth `state` (`qbOAuthState.ts`). Rotating
     it invalidates any in-flight QuickBooks connect.
   - Unchanged, but required for the QuickBooks tax path: `QB_ENVIRONMENT`,
     `QB_WEBHOOK_VERIFIER_TOKEN`.
3. **Apply migrations** (`cd backend && npx prisma migrate deploy`). Earlier tax migrations must
   already be applied; `migrate deploy` skips those.
4. **Recreate the backend** so it re-reads `env_file`:
   `docker compose up -d --force-recreate --no-deps backend`. A plain `restart` does not pick
   up env changes. Recreating the dev backend also reseeds the dev DB. Never do it on
   production data you want to keep.
5. **Reload the Prometheus rule** (`TaxProviderFailureRateHigh` in `monitoring/alert-rules.yml`,
   mounted read-only at `/etc/prometheus/alert-rules.yml`, listed under `rule_files` in
   `monitoring/prometheus.yml`). Prometheus is not started with `--web.enable-lifecycle`, so
   `POST /-/reload` is unavailable. Send SIGHUP: `docker kill --signal=HUP prometheus`.
   If the edited file is not seen, run `docker compose restart prometheus`.
   Check at `http://localhost:9090/rules`.
