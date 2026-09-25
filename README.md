# dsh-live-inspector

DeepSeek Harness (DSH) Web plugin that provides a lightweight, real-time **Git Tree & Live Changes Inspector** in the right sidebar (`sidebar.right` tab).

## Features

- **Single Tab Architecture (Zero RAM Bloat)**: Instead of opening heavy editor/viewer tabs for every accessed file, it keeps everything inside a single, high-performance **Git Tree** tab (`~10 KB` memory footprint).
- **Live File Status Badges**:
  - `[M]` (Amber): Modified files (`edit`, `str_replace_editor`).
  - `[A]` (Emerald): Created / added files (`write`, `write_file`).
  - `[R]` (Sky Blue): Read / inspected files (`read`).
- **Real-Time Active Indicator**: Displays `⚡ Agent active on: <path>` with a pulsing live status on the exact file currently being touched.
- **Interactive Controls**:
  - Filter by `All`, `Changes (M/A)`, or `Reads (R)`.
  - Instant text filter search.
  - Optional `View` button to open a single file preview only when explicitly desired.
  - `Clear` button to reset the session file list.

## Installation

```bash
dsh plugin --profile web add github:datit309/dsh-live-inspector
```
