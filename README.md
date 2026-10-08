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

## MCP feedback tickets

Web AI clients can call `submit_ticket` with a title, details, and optional context URL. Tickets
are stored privately under `desk/inbox/tickets/` for review with `run_mruby_shell`; they
are not published to GitHub automatically.

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

## Pomodoro

`pomodoro_start` begins 25-minute work / 5-minute rest rounds (the 4th rest is 15 minutes). There is
no timer process: the phase is computed from the start time and attached to every tool reply as
`loka_context.pomodoro`. `start_job` is refused during a rest phase; running jobs continue.

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
