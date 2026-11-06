# oc-usage

A small OpenTUI dashboard for your OpenCode Go usage.

It shows the three allowance windows — 5-hour (rolling), weekly, and monthly — with:

- percent used (large) and percent remaining
- a colored usage meter that fills with used
- reset countdown
- reset time in your local timezone
- `LIMITED` state when a window is exhausted

```text
◆ OpenCode Go · carl's stuff                                            updated 2s ago

╭─ 5-hour window ──────────────╮ ╭─ Weekly ─────────────────────╮ ╭─ Monthly ────────────────────╮
│ 15% used                     │ │ 33% used                     │ │ 32% used                     │
│ ████░░░░░░░░░░░░░░░░░░░░░░░░ │ │ █████████░░░░░░░░░░░░░░░░░░░ │ │ █████████░░░░░░░░░░░░░░░░░░░ │
│ 85% left                     │ │ 67% left                     │ │ 68% left                     │
│ Resets in 3h 15m             │ │ Resets in 2d 13h             │ │ Resets in 23d 3h             │
│ Today at 15:05               │ │ Mon at 01:00                 │ │ Nov 29 at 15:36              │
╰──────────────────────────────╯ ╰──────────────────────────────╯ ╰──────────────────────────────╯

r refresh   o console   q quit                                                    60s auto-refresh
```

## Requirements

- OpenCode installed and the background service running
- Bun 1.3.14+ to run from source
- macOS arm64 for the prebuilt binary (the build uses the host target)

The dashboard reads from OpenCode's local background service. It does not need a browser session and does not contact any remote server except when you press `o` to open the Console.

## Run from source

```bash
bun install
bun run start
```

## Build the standalone binary

```bash
bun run build
./dist/oc-usage
```

`bun build --compile` embeds OpenTUI's native library and assets, so the binary is self-contained. It is large (~96 MB) because of that.

## Keys

| Key | Action |
| --- | --- |
| `r` | Refresh now |
| `o` | Open the OpenCode Console usage page |
| `q` | Quit |

`Ctrl+C` also quits and restores the terminal.

## Where the data comes from

The app calls this local endpoint:

```http
GET /api/experimental/usage/limits
Authorization: Basic base64("opencode:<service password>")
```

It discovers the service from:

```text
$XDG_STATE_HOME/opencode/service.json
# or ~/.local/state/opencode/service.json
```

using the `url` and `password` fields.

### Getting the service password manually

You normally do not need to. The app reads it automatically.

To inspect it yourself:

```bash
cat ~/.local/state/opencode/service.json | jq -r .password
```

There is also a password-only fallback at:

```bash
cat ~/.config/opencode/service.json | jq -r .password
```

`OPENCODE_SERVICE_PASSWORD` is only needed when pointing the app at a custom or standalone server:

```bash
OPENCODE_SERVICE_URL=http://127.0.0.1:4096 \
OPENCODE_SERVICE_PASSWORD="$(jq -r .password ~/.local/state/opencode/service.json)" \
./dist/oc-usage
```

The service URL must be `localhost`, `127.0.0.1`, or `::1`; the app refuses to send the password anywhere else.

## Behavior

- Fetches on start, then every 60 seconds.
- Ticks countdowns and the “updated” indicator every second.
- On a failed fetch, keeps the last good data and retries after 10 seconds.
- When a reset time passes, shows `Resetting…` and checks again shortly.
- If the service is down, shows an actionable error instead of starting or restarting it.
- At 80x24 the third card wraps below the first two. Below 80x24, a resize warning is shown.

## Troubleshooting

**“OpenCode service not found”**

Start the background service, or open OpenCode once:

```bash
opencode service start
```

**“Service authentication failed”**

The saved service password is stale. Restart the service:

```bash
opencode service restart
```

**“Not signed in to OpenCode”**

```bash
opencode auth login
```

**“No OpenCode Go subscription”**

The signed-in console workspace does not have an active Go plan.

## Notes and limits

- The endpoint is experimental/internal. It is isolated in `src/service.ts`, so a future OpenCode API change only needs a fix there.
- The API exposes percentages only, not tokens or dollars.
- The “monthly” window is a roughly 30-day cycle, not the calendar month.
- Only the active workspace is shown.
- This version targets macOS arm64; adjust the `build` script for another host/platform.
- There is no automated test suite in v1. Use `bun run typecheck` and the manual checks below.

## Manual checks

1. `bun run typecheck`
2. `bun run start` — verify data, colors, countdowns, and reset times.
3. Press `r`, `o`, and `q`.
4. Resize to 80x24, 100x30, and 120x40.
5. Simulate a service failure without touching the real service:

   ```bash
   OPENCODE_SERVICE_URL=http://127.0.0.1:1 OPENCODE_SERVICE_PASSWORD=x bun run start
   ```

6. Build and run the binary:

   ```bash
   bun run build
   ./dist/oc-usage
   ```
