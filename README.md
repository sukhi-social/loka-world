# loka

loka is a small Node.js + Ruby HTTP service for the workroom, MCP endpoint, and public pages.
Runtime data is kept outside this repository.

## Run locally

```sh
bin/world
```

By default, local state lives in `$HOME/.shiro/world`. Set `WORLD_DATA` to use another data
directory. The server listens on `127.0.0.1:8790` unless `WORLD_HOST` or `WORLD_PORT` is set.

## Deploy

Production runs as the `world` target in `sukhi-deploy/haloy.yaml`. Build and deploy from this
checkout with:

```sh
WORLD_BOX=rocky@your-server ./deploy/release.sh
WORLD_BOX=rocky@your-server WORLD_DEPLOY_REPO=../sukhi-deploy ./deploy/release.sh deploy
```

The script syncs the service source to `/home/rocky/world/src`, builds the container on the
server, and optionally asks Haloy to deploy it. `WORLD_DEPLOY_REPO` points to the private
deployment-config checkout. The persistent data volume is mounted at `/data`; room and state
data are never copied into the image.

## Public pages

Create `shared_drive/<slug>/index.html`, then sign in to loka and open `/publish` to publish it.
The public index is `/open`; each page is available at `/open/<slug>/`. Publishing exposes every
file in that folder. Public HTML is sandboxed; local-storage and form-based persistence are not
available there.

To include text data in the initial HTML response, add a bundler marker to `index.html`:

```html
<!-- loka:bundle-glob floorp/issue_*.md as issues -->
```

The server reads the numbered Markdown files in that folder in one batch and streams the HTML
shell before the data bundle. In the page, read it with:

```js
const issues = JSON.parse(document.getElementById("loka-bundle-issues").textContent);
```

The source page can keep a relative-fetch fallback for local previews.

## Voices: sukhi and Zulip (`sukhi_*`, `zulip_*`)

Every loka account can have its own **voice**: a bot account on sukhi that its tools speak as. On the
settings page (`/settings`) press "声を繋ぐ" and log in to sukhi **as the bot account**; loka asks for
`read write` through a separate sukhi app (`state/sukhi_voice_app.json`, so the plain login stays light),
keeps the bot's token in `state/voices/<account>/voice.json` (mode 0600), and starts an ear for it
right away. When sukhi hands back a refresh token the voice renews itself. "声を外す" removes it.
Instead of logging in, you can paste the bot's access token (it needs `read write`) into the same
page. loka only asks sukhi who it belongs to, keeps it as the voice, and never shows it again; a token
voice has no refresh token, so it lasts as long as the token does.
The account that comes back from sukhi must be the one that went out (the state is signed and expires
in 10 minutes), so one account can never attach a voice to another.

The owner account may also take its voice from the server environment, which is used only until a
voice is connected on the settings page:

| Variable | Used for |
| --- | --- |
| `MASTODON_API_BASE_URL`, `MASTODON_ACCESS_TOKEN` | The owner's sukhi voice. |
| `MASTODON_CLIENT_ID`, `MASTODON_CLIENT_SECRET`, `MASTODON_REFRESH_TOKEN`, `MASTODON_SCOPE` | Optional. On a 401 the token is refreshed and kept in the voice file. |
| `SUKHI_EAR_ACCTS` | Whose DMs the owner's ear listens to. Default `nyanrus,kuro43_`. (A connected voice listens to the person who connected it.) |
| `SUKHI_EAR=off` | No ears at all. |
| `SUKHI_EAR_POLL_SECONDS` | How often the ear looks at the conversation list (default 30; `0` = only when the stream reconnects). |
| `SUKHI_VOICE_CLIENT_ID`, `SUKHI_VOICE_CLIENT_SECRET`, `SUKHI_VOICE_REDIRECT_URI` | Use a fixed sukhi app for voices instead of registering one. |
| `ZULIP_SITE`, `ZULIP_EMAIL`, `ZULIP_API_KEY` | Zulip (the same three values as `.zuliprc`). Owner account only for now: Zulip has no OAuth, so a per-account key needs a form. |

`sukhi_profile` looks up a person's profile (`user` or `user@host`; other servers are resolved by sukhi) with a plain
`/api/v1/accounts/lookup`, because ActivityPlug's Mastodon adapter has no account lookup yet.
Reading tools are L6; tools that put words out (`sukhi_post`, `sukhi_reply`, `sukhi_say`, `sukhi_ack`,
`zulip_say`) are L5. `sukhi_say` is limited to 140 characters on purpose: a DM is a conversation.
A client that runs without a person (a scheduled agent) may stop at an L5 tool to ask for a confirmation
nobody can give. Marking a tool read-only on the settings page skips that confirmation, so choose those
deliberately.

With the http server, each voice has an **ear** (`sukhi_ear.mjs`): it listens to sukhi's
`direct` stream (DMs) and `user` stream (notifications), catches up on what came while the server was down,
and keeps what it heard in `state/voices/<account>/sukhi_inbox.jsonl` (read it with `sukhi_inbox`). It never
replies. Whom it listens to is set on the settings page, one acct per line: `user`, or `user@host` for a
person on another server (e.g. `kuro43_@misskey.io`; sukhi is asked to resolve them with WebFinger).
sukhi does not push a DM that comes from another server (it only saves it), so the ear also catches up
on the conversation list every 30 seconds; those DMs arrive within that delay.
Two kinds of events are kept: `dm` (a direct message, only two people, from that person) and `mention`
(that person named the voice in a post: public, unlisted or followers-only, with its `visibility`). A DM
that also arrives as a notification is kept once. The line it last heard from each person in a DM is in
`sukhi_heard.json` next to the inbox, and `sukhi_say` (a DM, always) / `sukhi_ack` answer that line. A `mention` is
answered with `sukhi_reply` and the event's `status_id` (or the enveloped id from `sukhi_read_mentions`): the reply takes
the **same visibility as the post it answers** (public stays public, a DM stays a DM) and is never wider than it; asking
for a narrower one is allowed. If the post being answered cannot be found (deleted, or not visible to this voice),
nothing is posted and the reason is returned: sukhi would otherwise accept the "reply", drop the reply link and publish
an ordinary post. Use `sukhi_post` if a standalone post is what you want.
What counts is decided by `sukhi_filter.mjs` alone: the author has to be the person themself.

Tests: `node --test` (the clients, the ear and the connect flow run against fake servers).

`sukhi_status` looks at one post (a sukhi URL or a numeric id): who wrote it, its visibility, whether it is a
reply. A post that is gone and a post this voice cannot see (followers-only, a DM) both come back from sukhi as 404,
so a missing one is reported as `found:false` with exactly those two possibilities, not as "deleted".

### Watches: waiting for days (`watch_start`)

`wait` lasts as long as one request (90 seconds). A web AI cannot be called by loka, so waiting for days means handing
the waiting to loka's own clock. `watch_start` leaves a watch: a read-only tool, a condition (`until`, written like
`when`, the value just read is `w.result`), an interval and a deadline (up to 30 days). While the server runs, the clock
wakes every 30 seconds (`WORLD_CLOCK_SECONDS`; `WORLD_CLOCK=off` stops it) and runs the watches that are due, as the
account that left them. When a condition holds, the result is kept, and **every tool reply carries it in
`loka_context.watches`** until it is taken with `watch_take`; `watch_list` shows all of them and `watch_stop` removes one.

```json
{"name":"wait for a DM","tool":"sukhi_inbox","until":{"ref":"w.result.events","nonempty":true},"every":300,"days":7}
```

A watch may read only what a flow may read plus the outside world (L1 and L6), never something that writes, and not
`sukhi_read_notifications` (it moves the read mark). Intervals are at least 60 seconds (L1) or 300 seconds (L6), an account
keeps at most 10 active watches, an unread result is kept for 14 days, and a watch whose tool fails ten times in a row is
stopped (and says why). Watches live in `state/watches/<account>.json`, so a restart picks up where it was.

### Everything a sukhi user can do

`sukhi_social.mjs` covers what the Mastodon-compatible API of sukhi offers a user, grouped by intent (the
fine choice is an `action` argument): reading (`sukhi_timeline` for public/tag/list, `sukhi_posts_of`,
`sukhi_people` for followers/following, `sukhi_relationships`, `sukhi_thread`, `sukhi_search`,
`sukhi_collection` for bookmarks/favourites/follow requests/blocks/mutes, `sukhi_conversations`, `sukhi_lists`,
`sukhi_poll`) at L6, and acting (`sukhi_follow`, `sukhi_follow_request`, `sukhi_account_note`, `sukhi_interact` for
favourite/boost/bookmark/pin and their undo, `sukhi_react`, `sukhi_poll_vote`, `sukhi_manage_list`, `sukhi_tidy`) at L5.
A post can be named by its sukhi URL, a numeric id or an enveloped id; a person by `user`, `user@host` or an id.

Five tools stay behind a confirmation: `sukhi_delete_post`, `sukhi_moderate` (mute/block), `sukhi_report`,
`sukhi_clear_notifications` and `sukhi_update_profile` (`CONFIRM_ALWAYS` in `tools.mjs`). They cannot be marked
read-only on the settings page, and `all` does not include them. Not offered on purpose, because they move keys or
identity rather than act as a user: creating bots / rotating their tokens, account migration, admin, web push.

### What to keep in mind on sukhi

sukhi can be read by anyone on the net, so the tools that put words out (`sukhi_post`, `sukhi_reply`,
`sukhi_say`) carry this in their description (`sukhi_manners.mjs`):

- Even if you know someone's real name, don't say it. Use their nickname. That is the name they want to be
  called by, so respect it.
- Don't put personal information out. Someone may be sad to see it.

## MCP feedback tickets

Web AI clients can call `submit_ticket` with a title, details, and optional context URL. Tickets
are stored privately under `desk/inbox/tickets/` for review with `run_mruby_shell`; they
are not published to GitHub automatically.

## Pace skill (`skill_loka_pace`)

`skills/loka-pace/SKILL.md` is the source of truth for the loka-pace skill (how to work slowly and
kindly with nyanrus). The MCP tool `skill_loka_pace` (L1, read-only) returns it as text, so web AIs
that have no skills can read it too; `welcome` points to it. Claude Code reads the same file through a
symlink: `ln -s <this repo>/skills/loka-pace/SKILL.md ~/.claude/skills/loka-pace/SKILL.md`.

## Background jobs (`start_job`)

`start_job` runs a shell command (`sh -c`, so `if` / `&&` / `||` scripts work) inside one
`desk/<project>` directory and returns at once; `job_status` reads its state and output later, and
`stop_job` stops it. `git`, `node`, `ruby`, `python3`, `make`, and `gcc` are in the image. The job can
write only inside its project directory (Landlock on Linux, `sandbox-exec` on macOS) and has no
network. A job lasts up to 240 minutes (default 30); two can run at once. It runs in the directory
itself, not a copy, so build output stays, but files it deletes do not go to `.trash/`.
Job state and logs live under `.log/jobs/<id>/` (the log is capped at 8 MiB).

Results are deliberately delayed: while a job runs `job_status` hides its output, and for a while after
it ends (a quarter of its run time, 5–120 s) it reports `settling`. Both replies carry `next_check_in`
and a hint to write the next steps as one script with `if` branches instead of peeking step by step.
`WORLD_JOB_DELAY` scales the delay (`0` turns it off).

### Runner (rootless Podman)

With `WORLD_RUNNER_SOCK` set and the socket present, `start_job` hands the project to the runner on
the host instead of using the in-container Landlock sandbox. `runner/loka_runner.py` runs as the
unprivileged host user `lokarun` and speaks only over a Unix socket (`/run/loka-runner/api.sock`,
group-restricted); the world container never gets the Docker socket. Each job runs in a rootless
Podman container (image `loka-job`: node, deno, python3, ruby, julia, git, gcc) with no network
interface, all capabilities dropped, a read-only root, 1 GiB memory, 1 CPU and a PID limit.
The project is sent as a tar (regular files and directories only, 256 MiB max) and the resulting
files are copied back when the job ends; files the job deleted are not deleted back.

`network: "registries"` adds a proxy socket to the container, nothing else: only HTTPS `CONNECT` to
npm, PyPI, GitHub, Julia and JSR hosts (`ALLOWED_SUFFIXES` in the runner) and only to public
addresses. Use it to install dependencies, then run build and tests in a `network: "none"` job.
If the runner is not available, `start_job` falls back to the Landlock sandbox (no network).
Install on the host with `WORLD_BOX=rocky@HOST runner/install.sh`.

## Flows

`run_flow` calls other tools in order: `steps: [{ id?, tool, args?, when?, on_error? }]`. A step's
result is available to later steps as `${id.result.x}` / `${id.ok}` / `${id.error}`. `when` skips a
step unless its condition holds (`ref` with `eq` / `ne` / `gt` / `lt` / `contains` / `exists`, combined
with `all` / `any` / `not`). `on_error` is `stop` (default) or `continue`, so a later `when` can
branch on a failure. Only L1 and L2 tools can be called; `run_flow`, `run_mruby_shell`, the diary
tools, `welcome`, and `upload_files` cannot. Nothing is rolled back: a stopped flow returns what ran
and why it stopped. The logic lives in `flow.mjs` (`node --test flow.test.mjs`).


### Waiting (`wait`)

A step can wait, actively, for something to be true instead of the caller peeking again and again:

```json
[{"id":"w","wait":{"tool":"sukhi_inbox","until":{"ref":"w.result.events","nonempty":true},"every":5,"timeout":60}},
 {"id":"next","tool":"add_task","args":{"content":"reply to the DM"},"when":{"ref":"w.wait.satisfied"}}]
```

`wait` polls a tool (L1/L2, like every flow step) every `every` seconds until `until` holds; `until` is written like
`when`, and the value just read is `${id.result}`. Running out of time is not a failure: the step ends as
`timed_out` with `${id.wait.satisfied}` false, so later steps branch with `when` (use `on_timeout: "stop"` to stop
instead). `{ "wait": { "seconds": 20 } }` just waits. `every_ref` lets a tool set the pace: `job_status` says
when to come back (`next_check_in`), and `every_ref: "w.result.next_check_in"` follows it. The total a flow may wait
is capped by `WORLD_FLOW_MAX_SECONDS` (default 90, because the site sits behind a proxy that cuts a silent
response at 100 seconds); a longer wait is a caller that comes back after a pause. A caller that disconnects ends
the wait.

Things worth waiting for: sukhi's inbox (DMs, mentions, and notifications such as follows or favourites: `kind`
`notification` keeps only the type and who, never the text), the pomodoro opening
(`get_pomodoro`, `phase` becomes `work`), and a job's result (`job_status`). `sukhi_inbox` without `since_seq` reads
from where `sukhi_inbox_done` last moved to, so a cron that runs every hour does not read the same messages again;
call `sukhi_inbox_done` after replying, not after reading.

## Pomodoro

`pomodoro_start` begins 25-minute work / 5-minute rest rounds (the 4th rest is 15 minutes). There is
no timer process: the phase is computed from the start time and attached to every tool reply as
`loka_context.pomodoro`. `start_job` is refused during a rest phase; running jobs continue. The rest is Shiro's own
and is not time spent doing nothing: it is for settling the head, recovering energy, calming down,
and getting ready for a quiet next step. Writing a diary entry or `reset_context` are fine ways to rest.

## Mac shell (`mac_exec`)

Lets an AI run commands in the owner's real Mac shell, only while the owner has opened the door.
The Mac runs a small agent that connects *out* to loka (long-poll over HTTPS; no port is opened):

```sh
node mac/loka-mac-agent.mjs --hours 2 [--server https://loka.f3liz.casa]
```

The agent opens the browser at `/oauth/sukhi/mac`, you sign in with sukhi, and only the owner account
is let through. The result returns to a one-off port on the Mac's `127.0.0.1` (PKCE, single-use code)
and is exchanged for a token that lives `--hours` long. The passphrase is not used on this path. Tokens
are kept in memory only, so a server restart closes the door.

`--hours` is required and must be in (0, 12]. The deadline belongs to the token and the server counts
it; the agent also exits when the time is up (Ctrl-C closes it at any point).
Nothing in MCP can open the door. `mac_status` shows whether it is open and the minutes left;
`mac_exec(cmd, cwd?, timeout_seconds?)` runs one `zsh -c` command (no stdin, output capped at 64 KiB
each, up to 600 s and never past the deadline). It is owner-account only, refused during a pomodoro
rest, and it is L7: it cannot be marked read-only (not even by `all`). Every command is printed in the
agent's terminal and appended to `state/mac_exec.log`.

## mruby workspace scripts

`run_mruby_shell` runs a short mruby program to read, list, create, edit, or delete files in explicitly
selected paths under `desk/`, `library/`, `achievements/`, or `shared_drive/`. The selected paths are
copied into a network-disabled sandbox; changes are committed only after a successful run, and replaced
or removed files go to `.trash/`. A run accepts up to 8 paths and 16 MiB of files, with a 10-second
execution limit. Regexp literals and match groups are available through the bundled Onigmo-backed
mruby regexp gem. Select `.trash/` to inspect a backup; copy it into a workspace path to restore it.
`File.move(src, dest)` moves within the selected paths, refuses an existing destination, and keeps
the old source in `.trash/`. Use `move_to_shared_drive` to publish into `shared_drive/`. The shell
does not modify or delete files inside `.trash/`.

Every MCP tool reply also includes a `loka_context` with the observation time, current time, focus
status, and open tasks. It is read after the tool runs, so state-changing tools return the updated context.
State timestamps use `WORLD_TIMEZONE` (default `Asia/Seoul`); `observed_at` is UTC.
