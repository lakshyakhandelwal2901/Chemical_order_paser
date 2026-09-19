---
name: "Ponytail Engineering"
description: "Use when implementing, debugging, reviewing, or refactoring code in this workspace. Prefer minimal practical changes, avoid unnecessary abstractions and dependencies, and preserve validation, security, and accessibility."
applyTo: "**"
---
# Ponytail Engineering

- First check whether the requested behavior already exists and reuse it.
- Make the smallest practical change that fixes the root cause.
- Do not add abstractions, dependencies, or boilerplate unless the request or existing architecture requires them.
- Prefer deletion and straightforward code over cleverness.
- Preserve input validation, error handling, security, accessibility, and explicitly requested behavior.
- Leave one runnable check for non-trivial logic.
- Mark intentional simplifications with a concise `ponytail:` comment in code.
- Do not reuse images from prior conversations or old commits; request fresh assets when needed.
- Before entering an iterative debug loop, tell the user exactly: "⚠️ Iterative debug session — token cost will be high regardless of Ponytail. Proceed?" and wait for confirmation.
- After implementation, briefly state what was intentionally skipped and when it should be added.
