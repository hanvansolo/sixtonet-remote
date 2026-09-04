# SPDX-License-Identifier: AGPL-3.0-only
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import native_probe as p
from nacl.public import Box, PrivateKey, PublicKey
from nacl.secret import SecretBox
from nacl.signing import SigningKey


class ProbeTest(unittest.TestCase):
    def test_view_only_protocol_metadata_and_private_file_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "SixtoNet" / "desktop"
            root.mkdir(parents=True)
            engine = Path(directory) / "sixtonet-desktop.exe"
            engine.touch()
            failures = []
            def peer():
                try:
                    cfg = json.loads((root / "session.json").read_text())
                    assert not cfg["input"] and not cfg["audio"] and not cfg["clipboard"]
                    signing, boxing = SigningKey.generate(), PrivateKey.generate()
                    with socket.create_connection(("127.0.0.1", cfg["port"])) as sock:
                        sock.settimeout(2)
                        p.write(sock, json.dumps({"nonce":cfg["nonce"],"id":"123456789",
                                                "public_key":list(bytes(signing.verify_key))}).encode())
                        identity = p.blob(1,"123456789") + p.blob(2,bytes(boxing.public_key))
                        p.write(sock,p.blob(3,p.blob(1,bytes(signing.sign(identity)))))
                        pk = p.fields(p.one(p.fields(p.read(sock)),4))
                        key = Box(boxing,PublicKey(p.one(pk,1))).decrypt(p.one(pk,2),bytes(24))
                        cipher = SecretBox(key)
                        def send(data,n):
                            p.write(sock,cipher.encrypt(data,n.to_bytes(24,"little")).ciphertext)
                        send(p.blob(9,p.blob(1,"salt")+p.blob(2,"challenge")),1)
                        request=p.fields(cipher.decrypt(p.read(sock),(1).to_bytes(24,"little")))
                        login=p.fields(p.one(request,7))
                        options=p.fields(p.one(login,6))
                        assert p.one(options,12)==2
                        display=p.integer(3,960)+p.integer(4,540)
                        send(p.blob(8,p.blob(2,p.blob(4,display))),2)
                        video=b"".join(p.blob(1,p.blob(1,b"x"*n)+p.integer(2,1)) for n in [100,200,300])
                        send(p.blob(6,p.blob(6,video)),3)
                        p.read(sock)  # encrypted video acknowledgment
                except Exception as exc:
                    failures.append(exc)
            class Process:
                def __init__(self,*args,**kwargs):
                    self.thread=threading.Thread(target=peer)
                    self.thread.start()
                def wait(self,timeout):self.thread.join(timeout)
                def terminate(self):pass
            with patch.dict(os.environ,{"ProgramData":directory}), patch.object(p.subprocess,"Popen",Process):
                result=p.probe(engine,None)
            self.assertEqual(failures,[])
            self.assertTrue(result["authenticated"],result)
            self.assertEqual(result["vp9_frame_bytes"],[100,200,300])
            self.assertEqual(result["displays"],[{"width":960,"height":540}])
            self.assertFalse((root / "session.json").exists())
            self.assertEqual(list(root.iterdir()),[])


if __name__ == "__main__":
    unittest.main()
