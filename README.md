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
are stored privately under `desk/inbox/tickets/` for review with `list_files` and `read_file`; they
are not published to GitHub automatically.
