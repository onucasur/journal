# Archive Viewer

A small local web app for browsing your tagged PNG groups: search by tags,
then view each group's images fullscreen with a slider.

No build step, no dependencies — just Node.js.

## Setup

1. Make sure you have Node.js installed (any reasonably recent version).
2. Point the server at your real files, either by editing the defaults at
   the top of `server.js`, or via environment variables when you run it:

   ```bash
   DATA_FILE=/absolute/path/to/data.json \
   IMAGES_DIR=/absolute/path/to/your/images \
   node server.js
   ```

   If you don't set these, it defaults to `./data.json` and `./images`
   inside this folder.

3. Open **http://localhost:3000** in your browser.

That's it — the server reads from disk directly, so there's nothing to
re-select on refresh, restart, or a new browser session.

## Notes

- `IMAGES_DIR` is scanned recursively, so your PNGs can live in
  subfolders — only the filename (not the path) needs to match what's
  in `data.json`, so keep filenames unique across your whole collection.
- The images directory is re-scanned on startup. If you add new images
  while the server is running, call `POST /api/rescan` (e.g.
  `curl -X POST http://localhost:3000/api/rescan`) to pick them up
  without restarting.
- `PORT` is also configurable via environment variable (default 3000).

## Data format (`data.json`)

```json
{
  "version": "0.0.1",
  "files": [
    {
      "files": ["2026-08-27-001.png", "2026-08-27-002.png"],
      "tags": ["tag 1", "tag 2"],
      "youtubes": ["https://youtu.be/xxxxxxxxxxx"],
      "news": "2026-08-24.png"
    }
  ]
}
```

Each entry in `files` is a **group**: a set of images that share tags,
optional YouTube links, and an optional news-clipping image.

## API (for scripting or building your own tools against it)

- `GET /api/data` — the full archive index as JSON
- `GET /images/:filename` — streams that image from `IMAGES_DIR`
- `POST /api/rescan` — re-scans `IMAGES_DIR` for new files
- `POST /api/groups` — add a new group
  ```json
  { "files": ["a.png","b.png"], "tags": ["t1"], "youtubes": [], "news": "" }
  ```
- `POST /api/groups/:filename/tags` — add/remove tags on the group
  containing `:filename`
  ```json
  { "add": ["new tag"], "remove": ["old tag"] }
  ```

## Running it in the background / on startup

For everyday use you probably want this running persistently. A couple
of simple options on Ubuntu:

```bash
# quick and dirty — keep it running after you close the terminal
nohup node server.js > archive-viewer.log 2>&1 &

# or, for something that survives reboots, create a systemd user service
# and point it at server.js with your DATA_FILE / IMAGES_DIR env vars.
```
