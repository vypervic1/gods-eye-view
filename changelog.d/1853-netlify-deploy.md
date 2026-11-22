- The app can be published to Netlify: the client is a static build, and the
  API runs as a Netlify Function that mounts the same provider middleware the
  dev server mounts, so the deployed site answers `/api/*` the same way
  (`Qoder`, #1853).
