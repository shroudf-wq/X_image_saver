"""テスト共通：疑似X（x.com / pbs.twimg.com）をローカルで配信し、拡張機能を読み込んだChromiumを起動する"""
import os, ssl, subprocess, threading, time, shutil
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

_TESTS = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(_TESTS, "fixtures")
WORK = os.path.join(_TESTS, ".work")
os.makedirs(WORK, exist_ok=True)
EXT = os.path.abspath(os.environ.get("EXT", os.path.join(_TESTS, "..", "extension")))
CHROME = os.environ.get("CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")


def make_handler(page_file):
    class H(SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            host = self.headers.get("Host", "")
            if "pbs.twimg.com" in host:
                if "BROKEN" in self.path:
                    data, ct = b"\x00not-an-image" * 50, "image/jpeg"
                elif "SHAPE" in self.path or ".png" in self.path or "format=png" in self.path:
                    data, ct = open(os.path.join(FIX, "shapes.png"), "rb").read(), "image/png"
                else:
                    data, ct = open(os.path.join(FIX, "land.jpg"), "rb").read(), "image/jpeg"
            else:
                data, ct = open(os.path.join(FIX, page_file), "rb").read(), "text/html; charset=utf-8"
            self.send_response(200); self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    return H


def serve(page_file, port):
    cert, key = os.path.join(WORK, "cert.pem"), os.path.join(WORK, "key.pem")
    if not os.path.exists(cert):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=t",
                        "-keyout", key, "-out", cert], check=True, capture_output=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(page_file))
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(cert, key)
    httpd.socket = c.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def launch(name, http_port, cdp_port, extra=()):
    prof = os.path.join(WORK, "profile_" + name)
    dl = os.path.join(WORK, "downloads_" + name)
    shutil.rmtree(prof, ignore_errors=True); shutil.rmtree(dl, ignore_errors=True)
    os.makedirs(os.path.join(prof, "Default")); os.makedirs(dl)
    import json
    json.dump({"download": {"default_directory": dl, "prompt_for_download": False}},
              open(os.path.join(prof, "Default", "Preferences"), "w"))
    proc = subprocess.Popen([CHROME, f"--user-data-dir={prof}", f"--remote-debugging-port={cdp_port}",
        f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
        f"--host-resolver-rules=MAP x.com 127.0.0.1:{http_port}, MAP pbs.twimg.com 127.0.0.1:{http_port}",
        "--ignore-certificate-errors", "--no-sandbox", "--no-proxy-server", "--no-first-run",
        "--no-default-browser-check", *extra, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    return proc, dl


class Results:
    def __init__(self): self.items = []
    def check(self, name, ok, detail=""):
        self.items.append((name, bool(ok)))
        print(("PASS " if ok else "FAIL ") + name + ("  -- " + str(detail)[:220] if detail != "" else ""), flush=True)
    def summary(self):
        n = sum(1 for _, ok in self.items if ok)
        print(f"\n== {n}/{len(self.items)} PASS ==")
        return n == len(self.items)
