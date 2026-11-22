- The pointer-ownership test passes on Windows. It compared the files it walks
  with the allow-list in the platform's path separator, so every allowed file
  read as an offender and the test failed on Windows only
  (`Qoder`, #1895).
