"""Наблюдение за сервером во время теста: CPU и память uvicorn и nginx, соединения к бэкенду.

python3 server_mon.py <секунд> [интервал]   — печатает строку JSON на каждый замер.
Только читает /proc, ничего не меняет.
"""

import json
import os
import subprocess
import sys
import time

TICK = os.sysconf("SC_CLK_TCK")


def pids(pattern):
    out = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out if int(p) != os.getpid()]


def cpu_rss(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            parts = f.read().rsplit(")", 1)[1].split()
        with open(f"/proc/{pid}/statm") as f:
            rss = int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
        return (int(parts[11]) + int(parts[12])) / TICK, rss
    except OSError:
        return 0.0, 0


def fds(pid):
    try:
        return len(os.listdir(f"/proc/{pid}/fd"))
    except OSError:
        return None


def backend_conns():
    n = 0
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        with open(path) as f:
            for line in f.readlines()[1:]:
                p = line.split()
                # локальный порт 8100 (0x1FA4), состояние ESTABLISHED (01)
                if p[1].endswith(":1FA4") and p[3] == "01":
                    n += 1
    return n


def main():
    total = float(sys.argv[1])
    step = float(sys.argv[2]) if len(sys.argv) > 2 else 2
    groups = {"uvicorn": "uvicorn app.main", "nginx": "nginx: worker"}
    prev = {}
    t_end = time.time() + total
    while time.time() < t_end:
        now = time.monotonic()
        row = {"ts": time.strftime("%H:%M:%S")}
        for name, pat in groups.items():
            cpu = rss = 0
            for pid in pids(pat):
                c, r = cpu_rss(pid)
                cpu += c
                rss += r
            if name in prev:
                pc, pt = prev[name]
                row[f"{name}_cpu"] = round((cpu - pc) / (now - pt) * 100)
            prev[name] = (cpu, now)
            row[f"{name}_mb"] = round(rss / 2**20)
        up = pids("uvicorn app.main")
        row["uvicorn_fds"] = fds(up[0]) if up else None
        row["backend_conns"] = backend_conns()
        row["load1"] = os.getloadavg()[0]
        print(json.dumps(row), flush=True)
        time.sleep(step)


if __name__ == "__main__":
    main()
