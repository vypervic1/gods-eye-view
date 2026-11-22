# Netlify deployment

The app is a Vite client plus a Node server that runs the provider
middleware. On Netlify the two parts split: the client is published as static
files and the server runs as a Netlify Function that mounts the same provider
middleware.

## What is where

| Piece | Path | Role |
| --- | --- | --- |
| Site configuration | `netlify.toml` | Build command, publish directory, function directory and the data files the function reads |
| SPA fallback | `public/_redirects` | Every path serves the one document the client reads its state from |
| API function | `netlify/functions/api.mjs` | Mounts the provider middleware and answers `/api/*` |
| Function tests | `netlify/tests/api.test.mjs` | The adapter over the real middleware |

## Deploying

```bash
npm ci
npm run build                 # writes dist/
npx netlify deploy --dir=dist --prod --no-build
```

`--no-build` publishes the bundle already in `dist/`. Without it the CLI runs
the build command from `netlify.toml` first, which is what a Netlify build
does for a site connected to a repository.

The first deploy creates the site and links it:

```bash
npx netlify sites create --name gods-eye-view-console
npx netlify link --id <site id>
```

## Configuration

Provider keys are read from the environment, never from the browser. On a
hosted deployment they are site environment variables, set with the CLI or in
the Netlify UI:

```bash
npx netlify env:set NOMINATIM_URL https://nominatim.openstreetmap.org --context=production
npx netlify env:set TOMTOM_API_KEY <key> --context=production
```

`NOMINATIM_URL` enables place search: unset, the geocoding routes answer
`NOMINATIM_DISABLED` and the app falls back to its own search. The other keys
the server reads are the ones in `.env.example`: `GOOGLE_MAPS_API_KEY`,
`GOOGLE_MAPS_SERVER_API_KEY`, `CESIUM_ION_TOKEN`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `MAPILLARY_CLIENT_TOKEN`, `AISSTREAM_API_KEY`,
`OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `FIRMS_API_KEY` and
`TOMTOM_API_KEY`.

Provider Settings is not reachable from a hosted site: the key-setup endpoint
answers local hostnames only, so a deployed site has no way to accept a key
from a browser. Set the environment variables instead.

## What the deployment cannot do

- **Provider keys from the browser.** As above, Provider Settings refuses a
  non-local host.
- **Long-lived streaming.** The AIS feed, the OpenAI Realtime session and the
  other websockets need a long-lived connection; the function answers a
  single request and Netlify's edge ends an idle function.
- **Writes to the deployment directory.** The function's working directory is
  read-only, so it keeps its caches and the camera catalogues in a writable
  temporary directory that links the bundled `config/` and `public/` into
  place.

## Limits

The edge stops a function that has produced nothing for about thirty seconds,
so the function gives its own work a deadline
(`GEV_FUNCTION_DEADLINE_MS`, 24 seconds by default) and answers
`503 provider_timeout` rather than a gateway page. A provider that is slow
from the function's region — OpenSky and the Launch Library both throttle
shared cloud addresses — is worth trying from a local `npm run dev`, where
the request leaves from the machine's own address.

The client caches what it can, and the app shows the last good answer when a
provider fails, so a throttled upstream costs freshness rather than the map.
