# Changelog

## 0.19.1

- Fixes connecting to the Assignment 2 course service after entering or changing your course key.

## 0.19.0

- Adds the Assignment 2 tutor. Your conversation returns when you reconnect,
  saved questions wait for the connection to come back, and you can start a new
  conversation while keeping earlier ones to read and export.
- Review suggested changes before accepting them. Accepted changes are saved;
  a warning appears if a suggestion removes comments you wrote.
- Assignment 1 history remains available to read and export.

## 0.18.16

- Exported chat now matches what the tutor panel shows you. Some of the service's
  internal bookkeeping had been appearing in the Markdown alongside your
  conversation, and it has been removed. Your questions, the tutor's replies, the
  files attached to each question, the record of any change you accepted or
  rejected, and the warnings about anything the service did not confirm are all
  still there. Export an earlier chat again to get the tidier version.

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
