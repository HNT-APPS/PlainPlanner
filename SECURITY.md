# Security policy

## Supported versions

Only the latest release of Plain Planner receives fixes. Please update to the newest version before reporting a problem.

## Reporting a vulnerability

Please **do not** report security problems in public issues, discussions or pull requests.

Report them privately through GitHub instead:

1. Open the [**Security** tab](https://github.com/HNT-APPS/PlainPlanner/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it and what an attacker could do with it.

You will get a reply as soon as possible, usually within a few days. Once the problem is confirmed, a fix will be released and you will be credited in the advisory, unless you prefer to stay anonymous.

## Scope

Plain Planner runs inside Obsidian and only reads and writes notes in your vault. It does not send any data over the network. Examples of issues worth reporting:

- the plugin reading, changing or deleting files it should not touch,
- note content that makes the plugin run unexpected code,
- data loss caused by the plugin.
