- A Netlify deployment answers `/api/*` with the API. Netlify evaluates the
  redirect rules before it looks for a function, so the SPA fallback on its
  own answered every API request with the app shell; the rules now send
  `/api/*` to the function first, and the function accepts the path in
  whichever shape the routing produced (`Qoder`, #1893).
