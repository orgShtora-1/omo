# Security reports

Report problems privately to the package maintainer before disclosing reproduction details.
Do not include API keys, authentication headers, private prompts, or proprietary source code.

This plugin runs inside OpenCode and uses its public permission, tool, and session interfaces.
An executor remains subject to the host's permissions. Consultation profiles deny shell execution
and edits. Diagnostics are local and metadata-only by default.

The package requires Bun 1.4.2 or newer and targets OpenCode V2. Validate fixes using the
permission-denial, cancellation, recovery, and installed-package tests as applicable.
