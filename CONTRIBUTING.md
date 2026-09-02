# Contributing to rhdh-parasol/rhdh-plugins

This is the **rhdh-parasol** playground for experimenting with RHDH plugins. Contributions, fixes, and new ideas are all welcome.

## Proposing a change

1. Fork the repository or create a branch off `main`.
2. Make your changes and commit them with a clear message.
3. Open a pull request against `main`.

## Pull request expectations

- Include a description of **what** changed and **why**.
- Link the relevant issue from the PR when one exists (e.g., `Closes #123`).
- Keep each PR focused on a single change to make review easier.

## Creating changesets

Each workspace uses its own `.changeset` directory for release tracking.
When your change affects a published plugin, add a changeset so the release
pipeline can version and publish it automatically:

1. Run `yarn changeset` inside the workspace directory.
2. Select the affected package(s) and the appropriate bump level (`patch`,
   `minor`, or `major`).
3. Write a short summary of the change and commit the generated file with
   your PR.
