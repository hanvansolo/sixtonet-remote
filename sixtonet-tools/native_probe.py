# SPDX-License-Identifier: AGPL-3.0-only
"""Explicit, view-only lab test; never installed or run by the normal agent.

Run as SYSTEM with a pre-verified local SixtoNet desktop executable. Stops within
60 seconds. Reports protocol/frame metadata only; never writes media, returns
media, sends input, reads the clipboard or modifies an existing desktop grant.
Requires PyNaCl (the test dependency, not a shipped agent dependency).
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time

LIMIT = 8 * 1024 * 1024


def varint(value):
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def integer(field, value):
    return varint(field << 3) + varint(value)


def blob(field, value):
    if isinstance(value, str):
        value = value.encode()
    return varint((field << 3) | 2) + varint(len(value)) + value


def fields(data):
    pos = 0
    result = {}
    def number():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos >= len(data):
                raise ValueError("truncated protobuf")
            b = data[pos]
            pos += 1
            value |= (b & 127) << shift
            if b < 128:
                return value
        raise ValueError("invalid protobuf integer")
    while pos < len(data):
        tag = number()
        field, kind = tag >> 3, tag & 7
        if kind == 0:
            value = number()
        else:
            length = number() if kind == 2 else {1: 8, 5: 4}.get(kind)
            if length is None or length > LIMIT or pos + length > len(data):
                raise ValueError("invalid protobuf field")
            value = data[pos:pos + length]
            pos += length
        result.setdefault(field, []).append(value)
    return result


def one(data, field, default=b""):
    return data.get(field, [default])[0]


def exact(sock, n):
    value = bytearray()
    while len(value) < n:
        part = sock.recv(n - len(value))
        if not part:
            raise ConnectionError("native engine disconnected")
        value.extend(part)
    return bytes(value)


def read(sock):
    first = exact(sock, 1)
    size = int.from_bytes(first + exact(sock, first[0] & 3), "little") >> 2
    if not 0 < size <= LIMIT:
        raise ValueError("invalid native frame length")
    return exact(sock, size)


def write(sock, data):
    n = next(n for n in range(1, 5) if len(data) < 1 << (8 * n - 2))
    sock.sendall(((len(data) << 2) | (n - 1)).to_bytes(n, "little") + data)


def probe(engine, deps):
    if deps:
        sys.path.insert(0, str(deps))
    from nacl.public import Box, PrivateKey, PublicKey
    from nacl.secret import SecretBox
    from nacl.signing import VerifyKey
    import ctypes
    from ctypes import wintypes
    # SYSTEM SID is checked independently by the native executable too.
    if os.name != "nt":
        raise RuntimeError("Windows-only lab test")
    engine = engine.resolve(strict=True)
    if engine.name != "sixtonet-desktop.exe":
        raise ValueError("unexpected engine executable")
    root = Path(os.environ["ProgramData"]) / "SixtoNet" / "desktop"
    if not root.is_dir():
        raise RuntimeError("private desktop state must be provisioned first")
    config_path = root / "session.json"
    if config_path.exists():
        raise RuntimeError("another desktop grant exists; refusing to disturb it")
    owned = False
    proc = conn = None
    deadline = time.time() + 60
    nonce, password = secrets.token_hex(32), secrets.token_hex(32)
    result = {"engine": "rustdesk", "view_only": True, "saved_media": False,
              "authenticated": False, "displays": [], "vp9_frame_bytes": []}
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        cfg = dict(port=listener.getsockname()[1], nonce=nonce, password=password,
                   expires_at=int(deadline), input=False, clipboard=False, audio=False)
        try:
            with config_path.open("x", encoding="utf-8") as f:
                owned = True
                json.dump(cfg, f)
            proc = subprocess.Popen([str(engine)], creationflags=subprocess.CREATE_NO_WINDOW,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL)
            conn, _ = listener.accept()
            conn.settimeout(10)
            ready = json.loads(read(conn))
            if not hmac.compare_digest(ready.pop("nonce", ""), nonce):
                raise ValueError("native nonce mismatch")
            signed = one(fields(one(fields(read(conn)), 3)), 1)
            identity = fields(VerifyKey(bytes(ready["public_key"])).verify(signed))
            if one(identity, 1).decode() != ready["id"]:
                raise ValueError("native identity mismatch")
            pair = PrivateKey.generate()
            session_key = secrets.token_bytes(32)
            boxed = Box(pair, PublicKey(one(identity, 2))).encrypt(session_key, bytes(24)).ciphertext
            write(conn, blob(4, blob(1, bytes(pair.public_key)) + blob(2, boxed)))
            cipher = SecretBox(session_key)
            sent = received = 0
            def send(data):
                nonlocal sent
                sent += 1
                write(conn, cipher.encrypt(data, sent.to_bytes(24, "little")).ciphertext)
            while time.time() < deadline - 5:
                encrypted = read(conn)
                if len(encrypted) <= 1:
                    continue
                received += 1
                message = fields(cipher.decrypt(encrypted, received.to_bytes(24, "little")))
                if 9 in message:
                    challenge = fields(one(message, 9))
                    h1 = hashlib.sha256(password.encode() + one(challenge, 1)).digest()
                    response = hashlib.sha256(h1 + one(challenge, 2)).digest()
                    option = integer(1, 3) + integer(7, 2) + integer(8, 2) + integer(12, 2)
                    option += blob(10, integer(1, 1) + integer(4, 1)) + integer(11, 15)
                    login = blob(1, ready["id"]) + blob(2, response)
                    login += blob(4, "sixtonet-lab-probe") + blob(5, "SixtoNet view-only lab test")
                    login += blob(6, option) + integer(9, 1) + blob(11, "1.4.9") + blob(13, "Web")
                    send(blob(7, login))
                if 8 in message:
                    response = fields(one(message, 8))
                    if 1 in response:
                        result["error"] = one(response, 1).decode(errors="replace")[:300]
                        break
                    peer = fields(one(response, 2))
                    result["authenticated"] = True
                    result["displays"] = [{"width": one(fields(d), 3, 0), "height": one(fields(d), 4, 0)}
                                          for d in peer.get(4, [])]
                if 5 in message:
                    send(blob(5, one(message, 5)))
                if 6 in message:
                    video = fields(one(message, 6))
                    if 6 in video:
                        frames = fields(one(video, 6)).get(1, [])
                        result["vp9_frame_bytes"].extend(len(one(fields(frame), 1)) for frame in frames)
                    send(blob(19, integer(12, 1)))
                    if len(result["vp9_frame_bytes"]) >= 3:
                        break
                if 19 in message:
                    misc = fields(one(message, 19))
                    if 9 in misc:
                        result["error"] = one(misc, 9).decode(errors="replace")[:300]
                        break
        except Exception as exc:
            result["error_type"] = type(exc).__name__
        finally:
            if conn:
                conn.close()
            if owned:
                config_path.unlink(missing_ok=True)
            if proc:
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.terminate()
                    proc.wait(timeout=2)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--dependencies", type=Path)
    args = parser.parse_args()
    print(json.dumps(probe(args.engine, args.dependencies)))
