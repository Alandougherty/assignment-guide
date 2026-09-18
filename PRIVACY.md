# Privacy and coursework recording

Assignment Guide connects to the course service chosen by your teaching team.
Review its recording notice and confirm your identity before submitting work.
The repository publisher and your course service operator may be different parties.

After you accept, submitted questions and bounded snapshots of eligible assignment
files are recorded locally and sent to the course service. Snapshots can include
unsaved editor contents. The service retains the captured bundle and may send your
question, recent conversation and selected file contents to its AI provider.
Responses, outcomes, proposed edits and your decisions about edits are also recorded.
Unsent drafts are not recorded. Exported chats are ordinary files that you control.

The extension excludes dotfiles, dependency folders and known credential files.
These exclusions cannot identify every secret: keep passwords and personal data
out of coursework files. Git ignore rules do not control what the extension captures.

Your personal course key is saved in VS Code SecretStorage. It is sent to the course
service for authentication, not included in your chat export. Never post it in a
public issue, screenshot or repository. The extension contains no AI provider key.

Your course service's notice identifies its recording terms. Ask the teaching team
about the AI provider, retention period, access, deletion and data contact before
submitting if any of these are unclear. Uninstalling the extension does not request
deletion of server records and should not be assumed to delete local history.

Public GitHub issues are visible to everyone. Use only minimal synthetic examples;
report concerns involving keys or identified coursework privately to your teaching
team. Publishing this source does not authorise submission of real student data to
a service that is still designated for testing.
