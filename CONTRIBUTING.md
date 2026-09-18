# Development and feedback

This repository is source-available under restricted-use terms, not an open-source
licence. General reuse, modifications and redistribution require permission. Please
contact the maintainer before submitting code contributions.

Authorised maintainers can use Node.js 22 or later and npm:

```sh
npm ci
npm test
npm run package
```

Tests use synthetic fixtures and do not require a course key or live AI provider.
The VSIX is written under dist/. Packaging does not publish it. The repository
contains the VS Code client and shared protocol code, not the deployed course
service, its operating configuration or credentials.

The extension ID is alandougherty.assignment-guide. Existing command IDs remain compatible with current installations. Student
connections use the approved service address and a personal course key. Older prototype extension IDs are not imported; users must connect explicitly.

Report product problems using a small synthetic example. Do not include assignment
solutions, student identities, course keys or unredacted coursework logs.

## Student build boundary

This repository contains only the student entry point (`src/student.ts`) and its
shared client dependencies. Simulator implementations, sample assignments,
fictional previews and local provider-test adapters are not included. The shared
host has an optional development interface, but this package never supplies it or
exposes the development Test API, including in VS Code test hosts.

`npm run package` builds a fresh staging directory from the compiled student
runtime dependency graph, generates the student manifest and checks the actual
VSIX for development exclusions and required runtime assets. Packaging checks
require the `unzip` command. No course key or provider call is needed.

## Current limitations

Migration from prototype extension IDs has been removed. Uninstall older tutor
extensions before installing this package to avoid duplicate command registrations. Those installations
start through the normal course connection and consent flow; old records are not
imported or deleted. Existing state for the current extension ID is retained unless
the operator explicitly resets it. Fresh student installs require a teacher-supplied personal course key.

For compatibility, the v1 assignment definition contract permits omitted `files`,
which historically means `assignment.py` in Python. New service definitions should
supply an explicit file list. Assignment content comes from the course service,
not a built-in sample catalogue. Historical record/recovery schemas are retained;
experimental recovery activation remains disabled in the student entry point.

The repository does not include a course server. Production identity, recording
policy, retention and cohort capacity must be agreed with the course operator;
passing client tests is not certification of a complete production service.
