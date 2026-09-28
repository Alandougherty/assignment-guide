# Changelog

## 0.18.15

- Accepted changes now reach your file. About half of the changes students accepted
  were discarded without warning, after which the tutor told them they had not
  accepted anything. The check that threw them away compared editor documents, and
  VS Code had usually closed the document in the background where the file had no
  tab open. It now compares the file's own text, which is the check that protects
  you from applying a change to something you have edited since.
- Your file is saved once a change is applied. Before, the correction sat in an
  unsaved editor, so the work you handed in could still contain the mistake.

## 0.18.13

- Fixed `EPERM: operation not permitted, fsync`, which stopped the extension the
  moment a student connected. Every local write flushes to disk so a record
  survives a crash, and where VS Code's storage sits on OneDrive, a network share
  or behind some antivirus filters the filesystem refuses that flush. A refused
  flush is now tolerated. Flush failures meaning the data is genuinely in doubt,
  rather than merely unflushed, still fail loudly.

Releases before 0.18.13 were pre-course iterations published in September 2026.
0.18.13 was the first release used by a class.
