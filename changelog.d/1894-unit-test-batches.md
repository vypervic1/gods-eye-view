- The unit-test runner works on Windows again. It passed every test file to
  Node as one command line, which grew past the length a Windows process
  accepts, so `npm test` died before running anything. The files now go to Node
  in batches, and the same tests run as before (`Qoder`, #1894).
