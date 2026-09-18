# Changelog

## 0.18.5

- Display service-reported waiting status separately from tutor generation when
  supported by the course service. Ignore malformed or stale optional progress.
- Explain when a question remains saved after provider retry limits are reached.
- Update the client version reported to the course service.

Server retry scheduling and the extended test-host timeout remain opt-in trials.
This client release does not enable them, expand student request retries or activate
production record recovery. The 0.18.4 development checkpoint was not published.

## 0.18.3

- Clarify that access requires a personal key for a participating HKU course.
- Keep readable history available when local records are damaged, with a clear
  warning and protected write/retry behaviour. Exports retain that warning.
- Validate remembered consent before automatic reconnection; explain startup
  contact and post-edit file recording in the privacy notice.
- Show the captured file list beneath the composer after recording a question.
- Index validated revisions in memory and load only the latest 50 turns for chat;
  exports retain all readable turns. Detect conflicting revision sequence numbers.
- Replace chat exports atomically to preserve the previous copy if writing fails.
- Include full third-party notices, including bundled Markdown dependencies.
- Correct the client version sent to the course service and improve packaging
  diagnostics and compatibility with UUID-shaped directory names.

The 0.18.2 local checkpoint was not separately published. These changes do not
introduce server-side token enforcement or expand automatic request retries.

## 0.18.1

- Published student-only distribution with key-based course connection and bounded
  session authentication retries.
- Includes chat, reviewed single-file edits, chat export and server-reported token
  allowance. Course identity, assignment and recording terms come from the service.
