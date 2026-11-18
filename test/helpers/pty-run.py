"""
Runs a command on a pseudo-terminal and plays a script of keystrokes at it, so the CLI's interactive
paths (raw-mode pickers, masked key entry, live progress) run for real in the tests.

  python3 pty-run.py '<json script>' -- command args…

The script is {"cols": 100, "rows": 40, "steps": [{"expect": "text", "send": "keys", "after": 0.15}, …]}:
each step waits until `expect` has appeared in the output (after the previous step's match), then
sends `keys` once the program has had `after` seconds to start reading. On exit the program's whole
output and exit status are printed as one JSON line: {"output": "…", "code": 0, "missing": null}.
`missing` names the first `expect` that never appeared (and the program is then killed).
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

TIMEOUT = 90


def main() -> None:
    script = json.loads(sys.argv[1])
    command = sys.argv[sys.argv.index("--") + 1 :]
    cols, rows = script.get("cols", 100), script.get("rows", 40)
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.execvp(command[0], command)
    output = b""
    position = 0
    missing = None

    def read(wait: float) -> bool:
        nonlocal output
        ready, _, _ = select.select([fd], [], [], wait)
        if not ready:
            return True
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        output += chunk
        return True

    alive = True
    for step in script.get("steps", []):
        deadline = time.time() + TIMEOUT
        needle = step["expect"].encode()
        while alive and output.find(needle, position) < 0 and time.time() < deadline:
            alive = read(0.2)
        found = output.find(needle, position)
        if found < 0:
            missing = step["expect"]
            os.kill(pid, signal.SIGKILL)
            break
        position = found + len(needle)
        end = time.time() + step.get("after", 0.15)
        while alive and time.time() < end:
            alive = read(0.05)
        os.write(fd, step["send"].encode())
    while alive:
        alive = read(0.2)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    print(json.dumps({"output": output.decode("utf-8", "replace"), "code": code, "missing": missing}))


main()
