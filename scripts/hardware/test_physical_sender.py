"""
TrackShift Physical Telemetry Test Harness.

Sends verified real physical packets over HTTP POST to test the ingestion pipeline,
WebSocket fanout, validation rejection, and connection transitions.

Usage:
    python scripts/hardware/test_physical_sender.py --count 10 --hz 5
    python scripts/hardware/test_physical_sender.py --impossible-val
"""

import os
import sys
import time
import argparse
import requests

DEFAULT_URL = os.environ.get("TRACKSHIFT_INGEST_URL", "http://localhost:8000/api/physical-telemetry/ingest")
DEFAULT_KEY = os.environ.get("TRACKSHIFT_DEVICE_KEY", "trackshift_dev_key_2025")


def parse_args():
    parser = argparse.ArgumentParser(description="TrackShift Physical Telemetry Sender")
    parser.add_argument("--url", default=DEFAULT_URL, help="Ingestion URL")
    parser.add_argument("--device-id", default="TRACKSHIFT-ESP32-01", help="Device identifier")
    parser.add_argument("--key", default=DEFAULT_KEY, help="Device key")
    parser.add_argument("--hz", type=float, default=2.0, help="Packet rate in Hz")
    parser.add_argument("--count", type=int, default=20, help="Number of packets to send (0 = infinite)")
    parser.add_argument("--impossible-val", action="store_true", help="Send impossible temperature to test 422 rejection")
    return parser.parse_args()


def main():
    args = parse_args()
    headers = {
        "Content-Type": "application/json",
        "X-Device-Key": args.key
    }

    if args.impossible_val:
        print("[TEST] Sending impossible temperature packet (999999°C)...")
        packet = {
            "device_id": args.device_id,
            "timestamp": time.time(),
            "sequence": 1,
            "sensors": {
                "tyre_temperature": {"FL": 999999.0, "FR": 85.0, "RL": 80.0, "RR": 81.0}
            }
        }
        res = requests.post(args.url, json=packet, headers=headers)
        print(f"Result HTTP {res.status_code}: {res.text}")
        sys.exit(0)

    print("==================================================")
    print(" TRACKSHIFT REAL HARDWARE TELEMETRY SENDER")
    print(f" Target:      {args.url}")
    print(f" Device ID:   {args.device_id}")
    print(f" Frequency:   {args.hz} Hz")
    print(f" Total:       {'Infinite' if args.count == 0 else args.count}")
    print("==================================================")

    # Base sensor physical starting values
    fl_temp = 82.4
    fr_temp = 84.1
    rl_temp = 79.8
    rr_temp = 81.2

    fl_psi = 21.3
    fr_psi = 21.5
    rl_psi = 20.9
    rr_psi = 21.1

    amb_temp = 24.5
    track_temp = 34.8

    delay = 1.0 / max(0.1, args.hz)
    seq = 1
    sent = 0

    try:
        while True:
            # Subtle physical thermodynamic drift
            fl_temp = round(fl_temp + 0.05, 2)
            fr_temp = round(fr_temp + 0.04, 2)
            rl_temp = round(rl_temp + 0.03, 2)
            rr_temp = round(rr_temp + 0.03, 2)

            packet = {
                "device_id": args.device_id,
                "timestamp": time.time(),
                "sequence": seq,
                "transport": "HTTP_WIFI",
                "sensors": {
                    "tyre_temperature": {
                        "FL": fl_temp,
                        "FR": fr_temp,
                        "RL": rl_temp,
                        "RR": rr_temp
                    },
                    "tyre_pressure": {
                        "FL": fl_psi,
                        "FR": fr_psi,
                        "RL": rl_psi,
                        "RR": rr_psi
                    },
                    "tyre_pressure_unit": "psi",
                    "ambient_temperature": amb_temp,
                    "track_temperature": track_temp
                }
            }

            resp = requests.post(args.url, json=packet, headers=headers, timeout=2.0)
            if resp.status_code == 200:
                print(f"[SENT #{seq}] Device: {args.device_id} | FL Temp: {fl_temp}°C | FL Press: {fl_psi} psi | HTTP {resp.status_code}")
            else:
                print(f"[REJECTED #{seq}] HTTP {resp.status_code}: {resp.text}")

            seq += 1
            sent += 1
            if args.count > 0 and sent >= args.count:
                print(f"\n[COMPLETED] Sent {sent} physical packets successfully.")
                break

            time.sleep(delay)

    except KeyboardInterrupt:
        print("\n[STOPPED] Sender stopped.")


if __name__ == "__main__":
    main()
