"""
scripts/run_api.py — Robust Zero-Conflict API Launcher for TrackShift.

Gracefully clears any stale process occupying port 8000 before launching
Uvicorn to permanently prevent [WinError 10013] port binding conflicts.
"""

import sys
import os
import subprocess
import time
import socket

PORT = int(os.environ.get("PORT", os.environ.get("TRACKSHIFT_PORT", 8000)))


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def free_port(port: int):
    if not is_port_in_use(port):
        return

    print(f"[TrackShift Launcher] Port {port} is occupied by an existing process. Clearing...", flush=True)
    if os.name == 'nt':
        try:
            out = subprocess.check_output(f'netstat -ano | findstr :{port}', shell=True, text=True)
            pids = set()
            for line in out.strip().splitlines():
                parts = line.strip().split()
                if len(parts) >= 5 and 'LISTENING' in parts:
                    pids.add(parts[-1])
            for pid in pids:
                if pid and pid != '0':
                    subprocess.run(f'taskkill /F /PID {pid}', shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.8)
        except Exception as e:
            print(f"[TrackShift Launcher] Warning during port release: {e}", flush=True)
    else:
        try:
            subprocess.run(f'fuser -k {port}/tcp', shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.5)
        except Exception:
            pass


if __name__ == '__main__':
    free_port(PORT)
    extra_args = sys.argv[1:] if len(sys.argv) > 1 else ['--reload']
    cmd = [sys.executable, '-m', 'uvicorn', 'api.main:app', '--port', str(PORT)] + extra_args
    print(f"[TrackShift Launcher] Starting FastAPI on port {PORT} ({' '.join(extra_args)})...", flush=True)
    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\n[TrackShift Launcher] Server stopped cleanly.", flush=True)
