- Street Traffic works with the TomTom key products there are. A key that is
  refused by the Traffic Flow Maps endpoint is asked about on the Orbis Maps
  flow endpoint instead, and the endpoint that answered is remembered for that
  key. A key both endpoints refuse is reported as rejected and left alone
  instead of retrying every tile against the daily tile budget
  (`Qoder`, #1854).
