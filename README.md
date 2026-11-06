# oc-usage

A small OpenTUI dashboard for your OpenCode Go usage.

It shows the three allowance windows — 5-hour (rolling), weekly, and monthly — with:

- percent used (large) and percent remaining
- a colored usage meter that fills with used
- reset countdown
- reset time in your local timezone
- `LIMITED` state when a window is exhausted
- a pace warning when the current burn rate projects past 100% before reset

Below the allowance meters, a usage summary shows Console cost, requests, and
tokens for today, this week, and this month. The Usage title also shows today's
local activity pulse: sessions, steps, tool calls, failures, and streak. The
header shows how many OpenCode sessions are currently running.

The bottom panel has five tabs: **Activity** (the month chart and forecast),
**Models** (top Go models by steps), **Tools** (calls, failures, p50 latency),
**Projects** (top projects by local steps this month), and **Efficiency**
(cache hit rate, cost per request, tokens per request).

```text
◆ OpenCode Go · carl's stuff                         ● 2 running · updated 2s ago

╭─ 5-hour window ─────────────╮ ╭─ Weekly ────────────────────╮ ╭─ Monthly · ⚠ 142% ──────────╮
│ 21% used                    │ │ 36% used                    │ │ 33% used                    │
│ ██████░░░░░░░░░░░░░░░░░░░░░ │ │ ██████████░░░░░░░░░░░░░░░░░ │ │ █████████░░░░░░░░░░░░░░░░░░ │
│ 79% left                    │ │ 64% left                    │ │ 67% left                    │
│ Resets in 4h 58m            │ │ Resets in 2d 9h             │ │ Resets in 23d 3h            │
│ Today at 20:07              │ │ Mon at 01:00                │ │ Nov 29 at 15:36             │
╰─────────────────────────────╯ ╰─────────────────────────────╯ ╰─────────────────────────────╯

╭─ Usage · 31 sessions · 1,625 steps · 2,352 calls · 16 failed · 15d streak ───────────────────╮
│                                  Today                 This week                This month     │
│ Cost                             $3.38                    $11.95                    $11.95     │
│ Requests                         1,491                     2,092                     2,092     │
│ Tokens                          206.5m                    307.2m                    307.2m     │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯

╭─ Insights · Models · This month · Go · 2,070 steps ─────────────────────────────────────────╮
│ deepseek-v4.1-flash:max       1,745  ████████████████████████████████████           85%     │
│ kimi-k2.7-code:default          325  ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░           15%     │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯

r refresh   m cost   t tab   p period   g panel   o console   q quit        60s auto-refresh
```

The Activity tab mirrors the Console's Activity tab: solid bars are the days
elapsed so far this month, the hatched bars are the forecast for the remaining
days, and the title shows the month-to-date total and the projected month-end
total. Press `m` to chart cost, requests, or tokens.

The insights panel needs at least a 26-row terminal; on shorter terminals it is
hidden and the rest of the dashboard is unchanged.

## Insights tabs

| Tab | What it shows | Period |
| --- | --- | --- |
| Activity | Daily cost/requests/tokens for the current month + forecast | Current month |
| Models | Top Go models by steps, with share bars | `p` cycles today/week/month |
| Tools | Top tools by calls, failures, and p50 latency | `p` cycles today/week/month |
| Projects | Top projects by local steps | Current month |
| Efficiency | Cache hit %, cost per request, tokens per request | Today/week/month columns |

Model and project shares use local **steps**, not local cost: Go models can show
`$0` local cost, and local costs are estimates rather than billing. Steps are a
close proxy for Console requests. Console cost and requests remain the source of
truth for dollars.

## Requirements

- OpenCode installed and the background service running
- Bun 1.3.14+ to run from source
- macOS arm64 for the prebuilt binary (the build uses the host target)

The dashboard reads from OpenCode's local background service. Local session
analytics, model/tool/project breakdowns, and the running-session count come from
the same service. The usage summary uses the active Console credential saved by
OpenCode and calls the same Console API as the Activity → My usage page. Apart
from that request to `opencode.ai`, it does not contact any remote server except
when you press `o` to open the Console.

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
| `t` | Cycle the insights tab (Activity → Models → Tools → Projects → Efficiency) |
| `p` | Cycle the insights period (Today → This week → This month) for Models/Tools |
| `m` | Cycle the activity graph metric (cost → requests → tokens) |
| `g` | Show or hide the insights panel |
| `o` | Open the OpenCode Console usage page |
| `q` | Quit |

`Ctrl+C` also quits and restores the terminal.

## Where the data comes from

The app calls these local endpoints:

```http
GET /api/experimental/usage/limits
GET /api/credential
GET /api/experimental/session/stats?from=<epoch-ms>&to=<epoch-ms>&timezone=UTC&tools=detail
GET /api/session/active
GET /api/project
Authorization: Basic base64("opencode:<service password>")
```

The first supplies the allowance meters. The second supplies the active OpenCode
Console credential. (The service returns all stored credentials, but oc-usage
only reads the active `opencode` one.) The session stats endpoint supplies the
activity pulse, model mix, tool health, and streak. `/api/session/active`
supplies the running-session count. `/api/project` plus
one stats call per project supplies the Projects tab; that result is cached for
five minutes. Local stats use UTC day buckets to match the Console's dates.

The app then calls the Console usage endpoint with the active credential:

```http
GET https://opencode.ai/console/api/usage/summary
Authorization: Bearer <Console access token>
x-org-id: <workspace ID>
```

It is called three times — for today, this week, and this month — and supplies
the same cost, request, and token totals shown in the Console. The response's
input/output/cache token counts feed the Efficiency tab. To build the activity
graph it is called once more per elapsed day of the current month
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
- Polls active sessions every 10 seconds.
- Ticks countdowns and the “updated” indicator every second.
- On a failed fetch, keeps the last good data and retries after 10 seconds.
- If the usage summary fails but the allowance meters work, the meters stay
  visible and the summary is marked `stale` or `unavailable`. Local session
  stats, project usage, and the Console activity graph fail independently and
  keep their last good data the same way.
- Project usage is cached for five minutes; it makes one local stats call per
  project to group the month's steps by canonical path.
- When a reset time passes, shows `Resetting…` and checks again shortly.
- If the service is down, shows an actionable error instead of starting or restarting it.
- The Activity forecast projects month-to-date usage forward at the current daily average
  (`spent / days elapsed × days in month`), matching the direction of the
  Console's Activity forecast.
- The pace badge projects the current percentage forward at the same
  straight-line rate and appears when the projected percent at reset is above
  100%. It is a warning, not a guarantee.
- The Models tab ranks `opencode-go` models by steps; if there are no Go models
  it falls back to all providers and says so in the title. The Projects tab
  groups duplicate project IDs by canonical path.
- At 80x24 all three allowance cards stay in one row, with the usage table
  below; the insights panel is hidden until the terminal is at least 26 rows
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
- Local session stats are **this machine only**. The Console totals are workspace billing. Local costs are estimates and can differ from the Console; Go models can show `$0` locally. Model and project shares therefore use steps, not local cost.
- “Today” is the Console’s calendar-day range (UTC). The week starts Monday (UTC) and the month starts on the 1st (UTC), matching the Console’s date buckets. Local session stats also use UTC day buckets. The activity graph and pace warning use the same buckets.
- The activity graph issues one Console summary request per elapsed day to derive the daily series, so later in the month it makes more requests than the summary does. The forecast is a straight-line projection at the month-to-date average pace, not the Console’s own model.
- The pace badge is also a straight-line projection from the current percent and reset time. It only appears when the projection exceeds 100% at reset.
- Local stats use `from`/`to` epoch milliseconds. ISO date strings are not accepted by the endpoint.
- `streak` is computed for the requested range; the app reads it from an unfiltered all-time stats call.
- The Projects tab groups project IDs by canonical path because the service can return multiple IDs for the same directory.
- The app reads the active Console credential from the local OpenCode service and sends it only to `opencode.ai`.
- The “monthly” allowance window is a roughly 30-day cycle, not the calendar month.
- Only the active workspace and Console user are shown.
- This version targets macOS arm64; adjust the `build` script for another host/platform.
- There is no automated test suite yet. Use `bun run typecheck` and the manual checks below.

## Manual checks

1. `bun run typecheck`
2. `bun run start` — verify data, colors, countdowns, reset times, the activity graph, the usage pulse, and the insights panel.
3. Press `t` to cycle Activity → Models → Tools → Projects → Efficiency, `p` to cycle the period on Models/Tools, `m` (cost → requests → tokens), `g` (hide/show the panel), `o`, and `q`.
4. Verify the running-session badge appears when OpenCode has an active session.
5. Verify a pace warning appears on a meter when its current pace projects above 100% at reset.
6. Resize to 80x24 (insights hidden), 100x30 (insights shown), and 120x40.
7. Simulate a service failure without touching the real service:

   ```bash
   OPENCODE_SERVICE_URL=http://127.0.0.1:1 OPENCODE_SERVICE_PASSWORD=x bun run start
   ```

8. Build and run the binary:

   ```bash
   bun run build
   ./dist/oc-usage
   ```
