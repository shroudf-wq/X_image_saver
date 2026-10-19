import asyncio, os, json, shutil, subprocess, ssl, threading, time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright

_TESTS = os.path.dirname(os.path.abspath(__file__))
HERE = os.path.join(_TESTS, "fixtures")          # テスト用の画像・疑似ページ
WORK = os.path.join(_TESTS, ".work")              # 実行時に作られるもの（証明書・プロファイル・スクショ）
os.makedirs(WORK, exist_ok=True)
EXT = os.path.abspath(os.environ.get("EXT", os.path.join(_TESTS, "..", "extension")))
CHROME = os.environ.get("CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
PROFILE = os.path.join(WORK, "profile2")
DL = os.path.join(WORK, "downloads2")

class H(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        host = self.headers.get("Host", "")
        if "pbs.twimg.com" in host:
            f, ct = ("land.jpg", "image/jpeg") if "LAND" in self.path else ("shapes.png", "image/png")
        else:
            f, ct = "mock.html", "text/html; charset=utf-8"
        data = open(os.path.join(HERE, f), "rb").read()
        self.send_response(200); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

def serve():
    if not os.path.exists(os.path.join(WORK, "cert.pem")):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=test",
                        "-keyout", os.path.join(WORK, "key.pem"), "-out", os.path.join(WORK, "cert.pem")], check=True, capture_output=True)
    httpd = HTTPServer(("127.0.0.1", 8443), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(os.path.join(WORK, "cert.pem"), os.path.join(WORK, "key.pem"))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

async def main():
    shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(DL, ignore_errors=True)
    os.makedirs(os.path.join(PROFILE, "Default")); os.makedirs(DL)
    json.dump({"download": {"default_directory": DL, "prompt_for_download": False}},
              open(os.path.join(PROFILE, "Default", "Preferences"), "w"))
    serve()
    proc = subprocess.Popen([CHROME, f"--user-data-dir={PROFILE}", "--remote-debugging-port=9333",
        f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
        "--host-resolver-rules=MAP x.com 127.0.0.1:8443, MAP pbs.twimg.com 127.0.0.1:8443",
        "--ignore-certificate-errors", "--no-sandbox", "--no-proxy-server", "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9333")
            ctx = browser.contexts[0]
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
            page = await ctx.new_page()
            logs = []
            page.on("console", lambda m: logs.append("PAGE: " + m.text))
            await page.goto("https://x.com/home"); await page.wait_for_timeout(1500)

            box = await page.locator("#i1").bounding_box()
            await page.mouse.move(box["x"] + 100, box["y"] + 100)
            await page.mouse.move(box["x"] + 110, box["y"] + 105)
            await page.wait_for_timeout(400)
            print("ring shown during hover:", await page.evaluate("document.querySelector('.xsaver-ring').classList.contains('show')"))
            await page.wait_for_timeout(500)
            await page.screenshot(path=os.path.join(WORK, "shot_hover.png"))
            await page.wait_for_timeout(4000)
            print("first save done:", json.dumps(await sw.evaluate("chrome.storage.local.get(null)")))

            box2 = await page.locator("#i2").bounding_box()
            await page.mouse.move(box2["x"] + 50, box2["y"] + 50)
            await page.keyboard.press("s")
            await page.wait_for_timeout(300)
            await page.wait_for_timeout(4000)

            # 保存済みの画像に再ホバー → スキップされるはず
            await page.mouse.move(box["x"] + 200, box["y"] + 200)
            await page.wait_for_timeout(2500)

            hist = await sw.evaluate("chrome.storage.local.get(null)")
            print("downloads:", json.dumps(await sw.evaluate("chrome.downloads.search({}).then(r=>r.map(d=>[d.filename,d.state,d.fileSize]))"), indent=1))
            print("history:", json.dumps(hist, ensure_ascii=False, indent=1))
            scores = await sw.evaluate("""(async()=>{await ensureOffscreen();
              const a=await chrome.runtime.sendMessage({target:'offscreen',type:'classify',url:'https://pbs.twimg.com/media/LANDabc123?format=jpg&name=small'});
              const b=await chrome.runtime.sendMessage({target:'offscreen',type:'classify',url:'https://pbs.twimg.com/media/SHAPExyz789?format=png&name=small'});
              return {land:a, shapes:b};})()""")
            print("scores:", json.dumps(scores, indent=1))
            print("\n".join(logs))
            await sw.evaluate("chrome.storage.sync.set({threshold:0, perUserFolder:true}).then(()=>chrome.storage.local.clear())")
            await page.wait_for_timeout(300)
            await page.mouse.move(box2["x"] + 60, box2["y"] + 60)
            await page.keyboard.press("s")
            await page.wait_for_timeout(400)
            await page.screenshot(path=os.path.join(WORK, "shot_wait.png"))
            await page.wait_for_timeout(3000)
            await page.screenshot(path=os.path.join(WORK, "shot_nsfw.png"))
            await page.wait_for_timeout(1500)
            print("after threshold=0:", json.dumps(await sw.evaluate("chrome.storage.local.get(null)"), ensure_ascii=False))
            ext_id = sw.url.split("/")[2]
            opt = await ctx.new_page(); await opt.set_viewport_size({"width": 760, "height": 1100})
            await opt.goto(f"chrome-extension://{ext_id}/options.html"); await opt.wait_for_timeout(800)
            await opt.screenshot(path=os.path.join(WORK, "options.png"), full_page=True)
            await browser.close()
    finally:
        proc.terminate()
    for root, _, files in os.walk(DL):
        for f in files: print("file on disk:", os.path.relpath(os.path.join(root, f), DL), os.path.getsize(os.path.join(root, f)))

asyncio.run(main())
