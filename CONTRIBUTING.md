# Contributing to Plain Planner

Thank you for your interest in Plain Planner! Bug reports, ideas and code are all welcome.

## Reporting bugs

Open an [issue](https://github.com/HNT-APPS/PlainPlanner/issues) and include:

- your Obsidian version, operating system and Plain Planner version,
- what you did, what you expected and what happened instead,
- a small example of the note content that triggers the problem.

Please remove anything personal from your notes before you paste them.

## Suggesting features

Open an issue that describes the problem you want to solve, not only the solution. Plain Planner is meant to stay simple, so not every idea will be accepted, but every one will be read.

## Security issues

Please do not report security problems in public issues. Use GitHub's private vulnerability reporting instead: the **Security** tab of this repository, then **Report a vulnerability**.

## Pull requests

1. For anything bigger than a small fix, open an issue first so we can agree on the approach.
2. Fork the repository and create a branch from `main`.
3. Keep the change focused: one fix or feature per pull request.
4. Plain Planner has no build step: `main.js` is the plugin. Add or update tests in `tests/` and make sure they all pass:

   ```bash
   node --test tests/*.test.cjs
   ```

5. Describe what you changed and why in the pull request.

The maintainer reviews every pull request and may ask for changes, merge it, or close it if it does not fit the project.

## Licensing of contributions

Plain Planner is licensed under the [GNU General Public License v3.0 or later](LICENSE).

By submitting a contribution (code, documentation, translations or other material) to this repository, you confirm that:

1. you wrote it yourself or otherwise have the right to submit it;
2. your contribution is licensed under GPL-3.0-or-later, the same license as the project;
3. you also grant HNT Apps a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, sublicense and distribute your contribution under other license terms as well. This lets the project change or extend its license in the future without having to contact every contributor.

You keep the copyright to your contribution. If you do not agree with these terms, please do not submit a pull request.

## Name and forks

You are free to fork Plain Planner under the terms of the license. If you publish a fork, please use your own name for it and make clear that it is not the official plugin (see the README).
