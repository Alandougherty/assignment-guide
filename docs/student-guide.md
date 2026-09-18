# Using Assignment Guide

Assignment Guide helps you understand your assignment and develop your own
solution. Follow your teacher's instructions about permitted use and submissions.

## Install and connect

1. Download the Assignment Guide `.vsix` supplied by your teacher.
2. In VS Code, open **Extensions**, select **…**, then **Install from VSIX…**.
3. Select the supplied file and reload VS Code if prompted.
4. Open your assignment repository using **File → Open Folder**.
5. Run **Assignment Guide: Connect to Your Course** from the Command Palette,
   or choose **Connect to your course** in the setup screen. Enter your personal
   course key supplied by your teacher.
6. Choose **Continue**, check your identity and assignment, and read the recording
   notice. Choose **Confirm and start** only if the details are yours.

The student package needs a course connection. It has no local simulator or
preview commands. You do not need extension source, npm or F5. VS Code 1.106 or
newer is required. Keep your course key private; do not put it in assignment files.

If the course service is temporarily busy while connecting, the tutor retries for
up to ten seconds. Use **Cancel connection** to stop, or try again if it cannot
connect. An invalid course key is not retried automatically.

The tutor opens beside your editor. Run **Assignment Guide: Open** to return to it.
If the folder belongs to a different assignment, open the correct assignment
repository. The folder marker identifies the assignment; it does not identify you.

## Agreement and identity

Before you accept the service notice, connecting retrieves your identity and the
current notice without sending questions or coursework. Declining keeps tutoring
off. If the details are wrong, choose **These details aren’t mine** and reconnect
with the correct course key.

Acceptance is remembered on this device and checked when reconnecting. You may be
asked again if your identity, assignment or recording terms change. The chat shows
the assignment name; it does not repeat the recording notice above each exchange.

## Ask a question

Type your question and press **Enter** to send. Use **Shift+Enter** for a new line.
You can ask about the assignment, discuss your approach or request code feedback.
The submitted question stays visible while the tutor prepares a reply.

The tutor can use eligible text files from your assignment folder, including
unsaved editor contents. It does not depend on which file is currently open.
Capture has size limits and exclusions, so not every file is necessarily included.
Do not put secrets or personal information in assignment files. Local instruction
files such as TUTOR.md and AGENTS.md do not override the course's teaching policy.

Submitted questions, captured files, replies and edit decisions are recorded
locally and by the course service, as described in its notice. Unsent drafts are
not recorded. The saving status appears near the request controls. If your course
provides an allowance, the remaining tokens appear there too; hover for details.
A last-known balance can be out of date.

## Review suggested edits

Ask for a change in your question. If the tutor proposes an edit, select
**Review change** to inspect the differences, then **Accept change** or
**Reject change**. Accepted changes update your editor; save the file when ready.
If you have changed the file since the proposal, the tutor may refuse to apply it.
Ask for a fresh proposal against your current work.

You remain responsible for your work. AI replies can be wrong, and a proposed
change is not evidence that tests passed.

## Failed or interrupted requests

Keep the original submission when a request fails. If **Retry original submission**
is offered, it retries the saved question and snapshot, not your subsequently
edited files. To ask about newer work, send a new question.

If prompted, use **Reconnect to course** and confirm the correct identity.
Saved local history can remain readable without a connection; sending questions
requires the service. Do not delete extension storage to resolve a connection
problem, because it contains local records.

For extra troubleshooting controls, run **Assignment Guide: Toggle diagnostics**
from the Command Palette. Run it again to hide them. Diagnostics reset to hidden
when the window reloads. Ask your teacher for help with course keys or service errors.

## Export and update

Use **Export chat** to save a Markdown copy of the conversation available on this
device. The copy may be incomplete if some history is unavailable locally. Keep
exports private and follow your teacher's submission instructions.

To update, install the newer supplied VSIX and run **Developer: Reload Window**.
Updates using the same extension identifier preserve settings and saved history.
If upgrading from a prototype, uninstall its older tutor extensions first.
Older prototype extension IDs are not imported. Set up Assignment Guide with
your personal course key. Ordinary reloads and future updates retain the new
installation's settings and history.

### Files recorded with a question

After sending a new question, expand **Files included with your last question**
below the send controls to see the captured file paths. This is the bundle recorded
by the course service; the tutor may use only a selection of those files. The list
is shown after local recording, not as an additional approval step before sending.

### If saved history needs recovery

If a saved record cannot be read, the tutor shows the readable history with an
incomplete-history warning. Questions, retries and edit actions are paused to
protect your work. You can export the readable conversation; that export also
contains the warning. Contact your teaching team for recovery and keep the local
records intact. Reinstalling or deleting storage is not a recovery procedure.
