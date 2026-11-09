# Windows support implementation plan

**Goal:** Run the existing quota sidebar against the locally installed Windows Codex client.

**Architecture:** Keep the existing CDP widget and gateway API. Add Windows application discovery, loopback listener verification and daemon identification through PowerShell/CIM. Use a stop request file for graceful shutdown on Windows. Provide double-click launchers without dependencies or administrator access.

**Tech stack:** Node.js 22+, Windows PowerShell, existing Node test runner.

- [x] Add Windows regression tests for trusted executables, loopback listeners, daemon command lines with spaces, and application discovery. Run them before implementation.
- [x] Implement Windows platform helpers and integrate launch/status/stop while preserving explicit macOS test coverage.
- [x] Add Windows start/stop/status launchers and document the Windows workflow and optional Python backend.
- [x] Run all Node tests, render the widget in an isolated Windows Chromium profile, exercise real daemon start/status/stop, then enable the local sidebar. Restart the active client only if the user approves.
