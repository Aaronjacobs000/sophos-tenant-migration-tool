# Third-party attributions

## sophos-mcp (formerly sophos-central-mcp)

Portions of `backend/src/sophos/` are vendored from the
[sophos-mcp](https://github.com/Aaronjacobs000/sophos-mcp) project (formerly sophos-central-mcp)
(MIT License).

### Files vendored

| Upstream path | Local path |
| --- | --- |
| `src/auth/token-manager.ts` | `backend/src/sophos/auth/token-manager.ts` |
| `src/client/sophos-client.ts` | `backend/src/sophos/client/sophos-client.ts` |
| `src/client/tenant-resolver.ts` | `backend/src/sophos/client/tenant-resolver.ts` |
| `src/types/sophos.ts` | `backend/src/sophos/types/sophos.ts` |
| `src/client/fusion-client.ts` | `backend/src/sophos/client/fusion-client.ts` |

### Upstream commit

Vendored from the `main` branch. See each file's header comment for the
exact commit SHA at the time of the copy.

### Refreshing the vendored files

1. `git clone https://github.com/Aaronjacobs000/sophos-mcp /tmp/mcp`
2. Copy the first four files above from `/tmp/mcp/src/...` to their local paths.
3. Re-apply the constants tweak: replace imports of `SOPHOS_AUTH_URL` and
   `SOPHOS_GLOBAL_API` from `../config/config.js` with
   `../constants.js`.
4. Update the attribution header comment in each vendored file with the
   new upstream commit SHA.
5. Run `npm run build` and fix any type mismatches.
6. `fusion-client.ts` is a port, not a copy: compare it with upstream by hand
   and keep the local modifications below.

### Local modifications

- Import paths for constants redirected to `backend/src/sophos/constants.ts`.
- Attribution header block added to each file.
- **`tenant-resolver.ts`** is a fork: removed all partner / organization
  credential handling (loadTenants, getCachedTenants, getIdHeader). The
  resolver now only accepts tenant-scoped credentials and pulls the
  regional API host straight from `/whoami/v1`.
- **`sophos-client.ts`**: `globalRequest()` skips the caller's identity
  header when the request sets its own `X-Tenant-ID` or `X-Distributor-ID`,
  ported from upstream commit 89a43af. The Licensing API needs it. Only GET
  requests are retried after a 5xx, a timeout or a network error; a write
  that ends that way throws `UnclearWriteError`, because Sophos can answer
  500 and still make the change. A 429 still waits and resends any request.
- **`sophos.ts` (types)** is a fork: removed `SophosTenant`,
  `SophosTenantPage`, and `SophosIdType` (unused after the resolver fork).
- **`fusion-client.ts`** is a port: only what the AI Defense policy copy
  needs is kept (no presigned uploads, no partnerPreferences retry). Retries
  follow `sophos-client.ts`: a query is retried after a 5xx, a timeout or a
  network error; a mutation is sent once and an unclear answer throws
  `UnclearWriteError`. A 4xx throws `SophosHttpError`, and Fusion's 503 for a
  tenant it does not hold throws `FusionNotAvailableError`. The AI Defense
  documents in `backend/src/sophos/api/ai-defense.ts` follow upstream's
  `src/fusion/queries/ai-defense-policy.ts`.

## Fonts

`frontend/fonts/` bundles two fonts under the SIL Open Font License 1.1. The
licence texts sit next to the font files.

| Font | Source | Licence file |
| --- | --- | --- |
| Inter (variable, Latin subset) | [rsms/inter](https://github.com/rsms/inter) | `frontend/fonts/OFL-Inter.txt` |
| Geist Mono (variable, Latin subset) | [vercel/geist-font](https://github.com/vercel/geist-font) | `frontend/fonts/OFL-GeistMono.txt` |
