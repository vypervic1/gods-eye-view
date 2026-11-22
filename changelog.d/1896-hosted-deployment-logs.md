- A hosted deployment can write its own logs. The Realtime debug log is
  appended to a file under the server's source root, which on a hosted
  deployment is a read-only bundle, so every write failed. The deployment
  points the providers at a writable directory, and the function answers the
  log's empty `204` without a body (`Qoder`, #1896).
