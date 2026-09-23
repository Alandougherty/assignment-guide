# Changelog

## 0.18.13

- Fixed `EPERM: operation not permitted, fsync`, which stopped the extension the
  moment a student connected. Every local write flushes to disk so a record
  survives a crash, and where VS Code's storage sits on OneDrive, a network share
  or behind some antivirus filters the filesystem refuses that flush. A refused
  flush is now tolerated. Flush failures meaning the data is genuinely in doubt,
  rather than merely unflushed, still fail loudly.

Releases before 0.18.13 were pre-course iterations published in September 2026.
0.18.13 was the first release used by a class.
