"""Adversarial tests: open adv.html in a real Chromium with the extension loaded and try to break it"""
import asyncio, os, json, shutil, subprocess, ssl, threading, time, sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright

_TESTS = os.path.dirname(os.path.abspath(__file__))
HERE = os.path.join(_TESTS, "fixtures")          # テスト用の画像・疑似ページ
WORK = os.path.join(_TESTS, ".work")              # 実行時に作られるもの（証明書・プロファイル・スクショ）
os.makedirs(WORK, exist_ok=True)
EXT = os.path.abspath(os.environ.get("EXT", os.path.join(_TESTS, "..", "extension")))
CHROME = os.environ.get("CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
EXTRA = sys.argv[1:]  # e.g. --disable-webgl
REQS = []

class H(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        host = self.headers.get("Host", "")
        if "pbs.twimg.com" in host:
            REQS.append(self.path)
            if "BROKEN" in self.path:
                data, ct = b"\x00not-an-image" * 50, "image/jpeg"
            elif "SHAPE" in self.path or ".png" in self.path:
                data, ct = open(os.path.join(HERE, "shapes.png"), "rb").read(), "image/png"
            else:
                data, ct = open(os.path.join(HERE, "land.jpg"), "rb").read(), "image/jpeg"
        else:
            data, ct = open(os.path.join(HERE, "adv.html"), "rb").read(), "text/html; charset=utf-8"
        self.send_response(200); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

def serve():
    if not os.path.exists(os.path.join(WORK, "cert.pem")):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=t",
                        "-keyout", os.path.join(WORK, "key.pem"), "-out", os.path.join(WORK, "cert.pem")], check=True, capture_output=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 8443), H)
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(os.path.join(WORK, "cert.pem"), os.path.join(WORK, "key.pem"))
    httpd.socket = c.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

RESULTS = []
def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -- " + detail if detail else ""), flush=True)

async def main():
    prof = os.path.join(WORK, "profile_adv")
    shutil.rmtree(prof, ignore_errors=True); os.makedirs(os.path.join(prof, "Default"))
    serve()
    proc = subprocess.Popen([CHROME, f"--user-data-dir={prof}", "--remote-debugging-port=9334",
        f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
        "--host-resolver-rules=MAP x.com 127.0.0.1:8443, MAP pbs.twimg.com 127.0.0.1:8443",
        "--ignore-certificate-errors", "--no-sandbox", "--no-proxy-server", "--no-first-run", *EXTRA, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9334")
            ctx = browser.contexts[0]
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
            ext_id = sw.url.split("/")[2]
            # Record the actual download requests (filename, URL)
            await sw.evaluate("""(()=>{globalThis.__dl=[]; const o=chrome.downloads.download.bind(chrome.downloads);
              chrome.downloads.download=(opts)=>{__dl.push(opts); return o(opts).catch(e=>{__dl.push({err:String(e)}); throw e;});}; return true;})()""")
            page = await ctx.new_page()
            await page.set_viewport_size({"width": 900, "height": 700})
            await page.goto("https://x.com/home"); await page.wait_for_timeout(2500)

            async def hist():
                return await sw.evaluate("chrome.storage.local.get(null)")
            async def dl():
                return await sw.evaluate("__dl")
            async def hover(sel, wait=3500):
                await page.locator(sel).scroll_into_view_if_needed()
                b = await page.locator(sel).bounding_box()
                await page.mouse.move(b["x"] + 30, b["y"] + 30); await page.mouse.move(b["x"] + 40, b["y"] + 40)
                await page.wait_for_timeout(wait)
                return b

            # 0) Does classification work at all (also covers the WebGL-disabled case)
            r = await sw.evaluate("""(async()=>{await ensureOffscreen();return chrome.runtime.sendMessage({target:'offscreen',type:'classify',url:'https://pbs.twimg.com/media/LANDx?format=jpg&name=small'})})()""")
            check("classification works", bool(r and r.get("ok")), json.dumps(r)[:160])

            # A) format tampering
            await hover("#evil")
            d = await dl(); h = await hist()
            evil = [x for x in d if "EVIL" in str(x.get("url", ""))]
            fn = evil[0]["filename"] if evil else ""
            check("A: tampered format can't inject .. into the path", ".." not in fn and "/" not in fn.split("/")[-1].replace(".", ""), fn)
            check("A: tampered format doesn't leak into the URL", all("pwn" not in x.get("url", "") for x in evil), evil[0]["url"] if evil else "no download")

            # B) legacy URL
            await hover("#legacy")
            d = await dl()
            leg = [x for x in d if "LEGACY" in str(x.get("url", ""))]
            check("B: legacy URL (.png:small) is saved too", bool(leg), json.dumps(leg)[:200])
            if leg: check("B: saved as png", leg[0]["filename"].endswith(".png") and "format=png" in leg[0]["url"], leg[0]["filename"] + " " + leg[0]["url"])

            # C) a post X has flagged sensitive
            await hover("#blurred")
            h = await hist()
            v = h.get("saved:BLURccc333", {})
            check("C: posts X blurs as sensitive go to NSFW", v.get("label") == "NSFW", json.dumps(v, ensure_ascii=False))

            # D) quoted post
            await hover("#quoted")
            h = await hist(); v = h.get("saved:QUOTEddd444", {})
            check("D: quoted-post images aren't misattributed to the outer post", "/quoted_user_QUOTEddd444" in v.get("filename", ""), v.get("filename", "not saved"))

            # E) image disappears right after hovering
            await page.locator("#vanish").scroll_into_view_if_needed()
            b = await page.locator("#vanish").bounding_box()
            await page.mouse.move(b["x"] + 30, b["y"] + 30); await page.mouse.move(b["x"] + 35, b["y"] + 35)
            await page.wait_for_timeout(200)
            await page.evaluate("document.getElementById('vanishArt').remove()")
            await page.wait_for_timeout(2500)
            h = await hist()
            check("E: an image that vanished during the wait isn't saved", "saved:VANISHeee555" not in h)

            # F) move the mouse out of the window
            await page.locator("#edge").scroll_into_view_if_needed()
            b = await page.locator("#edge").bounding_box()
            await page.mouse.move(b["x"] + 30, b["y"] + 30); await page.mouse.move(b["x"] + 35, b["y"] + 35)
            await page.wait_for_timeout(150)
            await page.dispatch_event("html", "mouseout", {"relatedTarget": None})
            await page.evaluate("document.documentElement.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:null}))")
            await page.mouse.move(-5, -5)
            await page.wait_for_timeout(2500)
            h = await hist()
            check("F: leaving the window cancels the save", "saved:EDGEfff666" not in h)

            # G) corrupt image
            await hover("#broken", 5000)
            h = await hist(); v = h.get("saved:BROKENggg777")
            check("G: images that fail classification go to Unsorted (not lost)", bool(v) and v.get("label") == "Unsorted", json.dumps(v))

            # H) CON
            await hover("#con")
            d = await dl(); c = [x for x in d if "CON" in str(x.get("url", ""))]
            errs = [x for x in d if "err" in x]
            check("H: a Windows reserved name doesn't break the filename", bool(c) and not c[0]["filename"].split("/")[-1].upper().startswith("CON."), c[0]["filename"] if c else "none")

            # I) pressing S while typing doesn't save / X's own shortcut isn't stolen when not hovering
            n_before = len(await dl())
            await page.mouse.move(850, 650)  # not over an image
            await page.wait_for_timeout(300)
            await page.keyboard.press("s")
            check("I: X's own S key works when not hovering an image", await page.inner_text("#xkeys") == "x-shortcut:fired")
            await page.evaluate("document.getElementById('xkeys').textContent='x-shortcut:none'")
            await page.click("#box")
            b = await page.locator("#legacy").bounding_box()
            await page.evaluate("document.getElementById('box').focus()")
            await page.keyboard.type("sss")
            await page.wait_for_timeout(800)
            check("I: typing S in a text box doesn't save", len(await dl()) == n_before)

            # J) Settings screen: drag the slider -> storage.sync write quota (120/min)
            opt = await ctx.new_page()
            errors = []
            opt.on("pageerror", lambda e: errors.append(str(e)))
            opt.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            await opt.goto(f"chrome-extension://{ext_id}/options.html"); await opt.wait_for_timeout(500)
            for i in range(160):
                v = 200 + (i * 37) % 2800
                await opt.evaluate(f"(()=>{{const r=document.getElementById('hoverDelay');r.value={v};r.dispatchEvent(new Event('input'))}})()")
            await opt.wait_for_timeout(1500)
            await opt.evaluate("(()=>{const r=document.getElementById('hoverDelay');r.value=1500;r.dispatchEvent(new Event('input'));r.dispatchEvent(new Event('change'))})()")
            await opt.wait_for_timeout(1000)
            stored = await sw.evaluate("chrome.storage.sync.get('hoverDelay')")
            quota = [e for e in errors if "QUOTA" in e.upper() or "quota" in e]
            check("J: dragging the slider doesn't hit the sync write limit", not quota, (quota[:1] or [""])[0][:150])
            check("J: the final value is saved", stored.get("hoverDelay") == 1500, json.dumps(stored))

            # K) Settings: folder-name tampering
            await opt.fill("#baseFolder", "../../Windows. "); await opt.dispatch_event("#baseFolder", "change")
            await opt.wait_for_timeout(500)
            await sw.evaluate("chrome.storage.local.clear()")
            await sw.evaluate("__dl.length=0")
            await page.bring_to_front()
            await page.evaluate("document.activeElement.blur()")
            await hover("#quoted", 300)
            await page.keyboard.press("s")
            await page.wait_for_timeout(3500)
            d = await dl()
            fn = d[0]["filename"] if d else ""
            check("K: tampered folder name can't escape the download folder or break the name", fn and ".." not in fn and not fn.split("/")[0].endswith((".", " ")), fn)
            errs = [x for x in d if "err" in x]
            check("K: download succeeds", bool(d) and not errs, json.dumps(errs)[:200])
            await sw.evaluate("chrome.storage.sync.set({baseFolder:'X_Saver'})")

            # L) Race: hammer the same image from 2 tabs at once
            await sw.evaluate("chrome.storage.local.clear()"); await sw.evaluate("__dl.length=0")
            page2 = await ctx.new_page(); await page2.set_viewport_size({"width": 900, "height": 700})
            await page2.goto("https://x.com/home"); await page2.wait_for_timeout(1500)
            item = {"mediaId": "RACEzzz", "origUrl": "https://pbs.twimg.com/media/RACEzzz?format=jpg&name=orig",
                    "classifyUrl": "https://pbs.twimg.com/media/RACEzzz?format=jpg&name=small", "ext": "jpg", "user": "r", "statusId": "1", "index": "1"}
            # Sent via an extension page (sending from a content script is equivalent)
            res = await opt.evaluate("""(item)=>Promise.all([1,2,3,4,5].map(()=>chrome.runtime.sendMessage({type:'save',item})))""", item)
            saves = [x for x in await dl() if "RACE" in str(x.get("url", ""))]
            check("L: hammering the same image concurrently downloads it only once", len(saves) == 1, f"{len(saves)} downloads / " + json.dumps([r.get('status') for r in res]))

            # M) Can a non-extension origin (the page itself) tamper with messages?
            ok = await page.evaluate("typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage")
            check("M: the X page itself can't send messages to the extension", ok)

            # N) Settings changes from a content script (assuming the content script is compromised) are rejected
            # clearHistory should only be accepted from the settings screen. Verified statically.
            src = open(os.path.join(EXT, "background.js")).read()
            check("N: clearHistory checks the sender", "sender" in src.split("clearHistory")[1][:400] or "isExtensionPage" in src, "")

            await browser.close()
    finally:
        proc.terminate()
    print(f"\n== {sum(1 for r in RESULTS if r[1])}/{len(RESULTS)} PASS ==")

if __name__ == "__main__":
    asyncio.run(main())
