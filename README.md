# oc-usage

A small OpenTUI dashboard for your OpenCode Go usage.

It shows the three allowance windows — 5-hour (rolling), weekly, and monthly — with:

- percent used (large) and percent remaining
- a colored usage meter that fills with used
- reset countdown
- reset time in your local timezone
- `LIMITED` state when a window is exhausted

Below the allowance meters, a usage summary shows Console cost, requests, and
tokens for today, this week, and this month, and an activity graph at the bottom
charts this month's daily consumption and forecasts the rest of the month.

```text
◆ OpenCode Go · carl's stuff                                            updated 2s ago

╭─ 5-hour window ──────────────╮ ╭─ Weekly ─────────────────────╮ ╭─ Monthly ────────────────────╮
│ 16% used                     │ │ 33% used                     │ │ 32% used                     │
│ █████░░░░░░░░░░░░░░░░░░░░░░░ │ │ █████████░░░░░░░░░░░░░░░░░░░ │ │ █████████░░░░░░░░░░░░░░░░░░░ │
│ 84% left                     │ │ 67% left                     │ │ 68% left                     │
│ Resets in 3h 15m             │ │ Resets in 2d 13h             │ │ Resets in 23d 3h             │
│ Today at 15:05               │ │ Mon at 01:00                 │ │ Nov 29 at 15:36              │
╰──────────────────────────────╯ ╰──────────────────────────────╯ ╰──────────────────────────────╯

╭─ Usage ────────────────────────────────────────────────────────────────────────────────────────╮
│                                  Today                 This week                This month     │
│ Cost                             $2.46                    $11.03                    $14.82     │
│ Requests                           760                     1,361                     2,148     │
│ Tokens                          137.4m                    238.1m                    512.6m     │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯

╭─ Activity · November · $11.62 spent · $58.11 forecast ────────────────────────────────────────╮
│   █                                                                                          │
│   █ █                                                                                        │
│  █ ███░░░░░░░░░░░░░░░░░░░░░░░░░░                                                              │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯

r refresh   m cost   g graph   o console   q quit                                60s auto-refresh
```

The activity graph mirrors the Console's Activity tab: solid bars are the days
elapsed so far this month, the hatched bars are the forecast for the remaining
days, and the title shows the month-to-date total and the projected month-end
total. Press `m` to chart cost, requests, or tokens. The graph needs at least a
26-row terminal; on shorter terminals it is hidden and the rest of the dashboard
is unchanged.

## Requirements

- OpenCode installed and the background service running
- Bun 1.3.14+ to run from source
- macOS arm64 for the prebuilt binary (the build uses the host target)

The dashboard reads from OpenCode's local background service. The usage summary
uses the active Console credential saved by OpenCode and calls the same Console
API as the Activity → My usage page. Apart from that request to `opencode.ai`,
it does not contact any remote server except when you press `o` to open the
Console.

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
| `m` | Cycle the activity graph metric (cost → requests → tokens) |
| `g` | Show or hide the activity graph |
| `o` | Open the OpenCode Console usage page |
| `q` | Quit |

`Ctrl+C` also quits and restores the terminal.

## Where the data comes from

The app calls these local endpoints:

```http
GET /api/experimental/usage/limits
GET /api/credential
Authorization: Basic base64("opencode:<service password>")
```

The first supplies the allowance meters. The second supplies the active OpenCode
Console credential. (The service returns all stored credentials, but oc-usage
only reads the active `opencode` one.) The app then calls the Console usage
endpoint with that credential:

```http
GET https://opencode.ai/console/api/usage/summary
Authorization: Bearer <Console access token>
x-org-id: <workspace ID>
```

It is called three times — for today, this week, and this month — and supplies
the same cost, request, and token totals shown in the Console. To build the
activity graph it is called once more per elapsed day of the current month
(`from=<day>&to=<day>`, a few at a time), giving the per-day cost, request, and
token totals behind the chart. The Console credential is only ever sent to
`opencode.ai`. The local service is discovered from:

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

The service URL must be `localhost`, `127.0.0.1`, or `::1`; the app refuses to send the service password anywhere else. The active Console credential is only sent to `opencode.ai`.

## Behavior

- Fetches on start, then every 60 seconds.
- Ticks countdowns and the “updated” indicator every second.
- On a failed fetch, keeps the last good data and retries after 10 seconds.
- If the usage summary fails but the allowance meters work, the meters stay
  visible and the summary is marked `stale` or `unavailable`. The activity graph
  fails independently and keeps its last good data the same way.
- When a reset time passes, shows `Resetting…` and checks again shortly.
- If the service is down, shows an actionable error instead of starting or restarting it.
- The forecast projects month-to-date usage forward at the current daily average
  (`spent / days elapsed × days in month`), matching the direction of the
  Console's Activity forecast.
- At 80x24 all three allowance cards stay in one row, with the usage table
  below; the activity graph is hidden until the terminal is at least 26 rows
  tall. Below 80x24, a resize warning is shown.

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

**The usage summary says “unavailable”**

The app could not find an active OpenCode Console credential, or the Console
rejected it. Sign in again and press `r`:

```bash
opencode auth login
```

If that does not help, check your network connection to `opencode.ai`.

## Notes and limits

- The endpoints are experimental/internal. They are isolated in `src/service.ts`, so a future OpenCode API change only needs a fix there.
- The allowance limits endpoint exposes percentages only. Cost, requests, and tokens come from the Console usage API.
- The usage summary matches the Console’s **Activity → My usage** figures for the active workspace and user.
- “Today” is the Console’s Today range. The week starts Monday (UTC) and the month starts on the 1st (UTC), matching the Console’s date buckets. The activity graph uses the same UTC day and month buckets.
- The activity graph issues one Console summary request per elapsed day to derive the daily series, so later in the month it makes more requests than the summary does. The forecast is a straight-line projection at the month-to-date average pace, not the Console’s own model.
- The app reads the active Console credential from the local OpenCode service and sends it only to `opencode.ai`.
- The “monthly” allowance window is a roughly 30-day cycle, not the calendar month.
- Only the active workspace and Console user are shown.
- This version targets macOS arm64; adjust the `build` script for another host/platform.
- There is no automated test suite in v1. Use `bun run typecheck` and the manual checks below.

## Manual checks

1. `bun run typecheck`
2. `bun run start` — verify data, colors, countdowns, reset times, the activity graph, and the usage summary.
3. Press `r`, `m` (cost → requests → tokens), `g` (hide/show the graph), `o`, and `q`.
4. Resize to 80x24 (graph hidden), 100x30 (graph shown), and 120x40.
5. Simulate a service failure without touching the real service:

   ```bash
   OPENCODE_SERVICE_URL=http://127.0.0.1:1 OPENCODE_SERVICE_PASSWORD=x bun run start
   ```

6. Build and run the binary:

   ```bash
   bun run build
   ./dist/oc-usage
   ```
