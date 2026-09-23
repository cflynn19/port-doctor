# port-doctor

You ran `npm run dev` and got:

```
Error: listen EADDRINUSE: address already in use :::3000
```

Now you get to play detective with `lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill`.

Or you run:

```console
$ port-doctor 3000
✖ Port 3000 is occupied

  PID        48192
  Process    node
  Command    next dev
  User       connor
  Age        2h 14m
  Listening  *:3000 (tcp)

  Kill it? [y/N]
```

Zero dependencies. One file you can read in a sitting.

## Install

```bash
npm install -g port-doctor
```

Or without installing anything:

```bash
npx port-doctor 3000
```

## Usage

```bash
port-doctor 3000                 # diagnose, then ask before killing
port-doctor 3000 --kill          # don't ask
port-doctor 3000 --kill --force  # SIGKILL, for things that ignore SIGTERM
port-doctor 3000 5173 8080       # several at once
port-doctor 3000-3010            # a range
port-doctor                      # what's listening on this machine?
```

It takes whatever you have on your clipboard — `3000`, `:3000`, `localhost:3000`,
`http://localhost:5173/dashboard` all resolve to the same port.

### Options

| Flag | What it does |
| --- | --- |
| `-k`, `--kill` | Kill without prompting (`-y`/`--yes` are aliases) |
| `-f`, `--force` | Go straight to `SIGKILL` instead of `SIGTERM` |
| `-j`, `--json` | Machine-readable output; never prompts |
| `-t`, `--timeout <ms>` | How long to wait after `SIGTERM` before giving up (default 3000) |
| `--no-color` | Plain text (`NO_COLOR` works too) |
| `-h`, `--help` | Help |
| `-v`, `--version` | Version |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every requested port ended up free |
| `1` | A port is still occupied — you declined, or the kill failed |
| `2` | Bad usage, or no way to inspect ports on this machine |

So this works:

```bash
port-doctor 3000 --kill && npm run dev
```

And so does this, in a `predev` script:

```json
{ "scripts": { "predev": "port-doctor 3000 --kill", "dev": "next dev" } }
```

### JSON

```console
$ port-doctor 3000 --json | jq '.ports[].processes[] | {pid, name, age}'
{
  "pid": 48192,
  "name": "node",
  "age": "2h 14m"
}
```

Shape:

```jsonc
{
  "ports": [
    {
      "port": 3000,
      "free": false,
      "processes": [
        {
          "pid": 48192,
          "ppid": 48190,
          "user": "connor",
          "name": "node",
          "command": "next dev",
          "ageSeconds": 8043,
          "age": "2h 14m",
          "protocols": ["tcp"],
          "addresses": ["*:3000"],
          "killed": true      // only present when a kill was attempted
        }
      ]
    }
  ]
}
```

## What it won't do

- **Kill your own shell.** It walks up its own parent chain first and refuses
  anything in it, plus PID 1. `--force` does not override this — there is no
  version of "free port 3000" that requires killing your terminal.
- **Pretend `SIGKILL` is normal.** A plain `--kill` sends `SIGTERM` and waits, so
  your dev server gets to flush logs and clean up its socket. If it's still there
  after the timeout you're told to retry with `--force`, rather than having the
  decision made for you.
- **Silently fail on someone else's process.** If the port belongs to another
  user, it says so and tells you it'll need `sudo`.
- **Mistake a connection for a server.** UDP has no `LISTEN` state, so the socket
  list also contains outbound flows like `192.168.1.5:51605->…:443`. The trailing
  number there is the *remote* port; counting it would make an open browser tab
  look like a local server on 443. Only bound sockets count.
- **Kill a recycled PID.** The port is re-read immediately before signalling. If
  the process exited in the meantime and the OS handed its PID to something else,
  that PID is skipped rather than signalled.

## How it works

| Platform | Discovery | Details |
| --- | --- | --- |
| macOS, Linux | `lsof -nP -iTCP -sTCP:LISTEN` + `-iUDP`, falling back to `ss -ltnpH`/`-lunpH` | `ps -o pid,ppid,user,etime,comm,command` |
| Windows | `netstat -ano` | `Get-CimInstance Win32_Process` |

Age comes from `ps -o etime`, which is elapsed wall-clock time — no timestamp
parsing, no timezone bugs.

Discovery is one pass over the machine's sockets, filtered in process. Two `lsof`
calls and two `ps` calls total — whether you ask about one port or a
thousand-port range, which is why `port-doctor 3000-3999` is as fast as
`port-doctor 3000`.

## Development

```bash
npm test
```

38 tests, no test framework. The end-to-end ones spawn real servers on real
ephemeral ports and really kill them, including one that ignores `SIGTERM` to
exercise the `--force` path.

The unit tests inject a fake command runner, so the Windows `netstat` parsing is
covered from any platform, and one test asserts that scanning 500 ports still
costs exactly two calls — that is the guard against per-port scanning creeping
back in.

## License

MIT
