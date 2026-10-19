"""v1.2 の機能テスト：要確認フォルダ・キーでの手直し・ファイル移動・学習・振り分けページ・精度表示"""
import asyncio, os, json, sys
from playwright.async_api import async_playwright
import harness as H

R = H.Results()


async def main():
    H.serve("features.html", 8445)
    proc, dl = H.launch("features", 8445, 9335, sys.argv[1:])
    try:
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9335")
            ctx = browser.contexts[0]
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
            ext = sw.url.split("/")[2]
            page = await ctx.new_page()
            await page.set_viewport_size({"width": 900, "height": 800})
            await page.goto("https://x.com/home"); await page.wait_for_timeout(2500)
            opt = await ctx.new_page()
            errors = []
            opt.on("pageerror", lambda e: errors.append(str(e)))
            await opt.goto(f"chrome-extension://{ext}/options.html"); await opt.wait_for_timeout(500)

            async def entry(mid):
                return (await sw.evaluate(f"chrome.storage.local.get('saved:{mid}')")).get(f"saved:{mid}")
            async def dl_state(i):
                return await sw.evaluate(f"chrome.downloads.search({{id:{i}}}).then(r=>r[0]?{{exists:r[0].exists,state:r[0].state,f:r[0].filename}}:null)")
            async def setcfg(d):
                await sw.evaluate(f"chrome.storage.sync.set({json.dumps(d)})"); await page.wait_for_timeout(300)
            async def hover(sel, key=None, wait=4000):
                await page.locator(sel).scroll_into_view_if_needed()
                b = await page.locator(sel).bounding_box()
                await page.mouse.move(b["x"] + 30, b["y"] + 30); await page.mouse.move(b["x"] + 40, b["y"] + 40)
                if key:
                    await page.wait_for_timeout(150); await page.keyboard.press(key)
                await page.wait_for_timeout(wait)

            # F1 両モデルが動く・速度
            r = await sw.evaluate("""(async()=>{await ensureOffscreen();
               const u='https://pbs.twimg.com/media/LANDx?format=jpg&name=small';
               await chrome.runtime.sendMessage({target:'offscreen',type:'classify',url:u});
               const t=[]; let last; for(let i=0;i<3;i++){const t0=performance.now(); last=await chrome.runtime.sendMessage({target:'offscreen',type:'classify',url:u}); t.push(performance.now()-t0);}
               return {last, ms:t};})()""")
            R.check("F1: CPUでも速い計算方式(WebGL か WASM)を使う", r["last"].get("backend") in ("webgl", "wasm"), r["last"].get("backend"))
            has_marqo = os.path.exists(os.path.join(H.EXT, "models", "marqo", "model.onnx"))
            R.check("F1: NSFWJS が動き、Marqo は同梱時だけ動く", r["last"]["ok"] and r["last"]["nsfwjs"] and ((r["last"]["marqo"] is not None) == has_marqo), json.dumps(r["last"])[:200])
            R.check("F1: 1枚あたりの判定が1.5秒以内（温まった状態）", max(r["ms"]) < 1500, [round(x) for x in r["ms"]])
            dummy = bool(r["last"]["marqo"] and r["last"]["marqo"].get("dummy"))

            # F11 ブラウザ側の前処理が元の(timm)前処理と同じ結果になるか（Marqo同梱時のみ）
            ref_path = os.path.join(H.FIX, "marqo_reference.json")
            if has_marqo and os.path.exists(ref_path):
                ref = json.load(open(ref_path))
                got = await sw.evaluate("""(async()=>{const o={};
                   for (const [n,u] of [['land.jpg','LANDref?format=jpg'],['shapes.png','SHAPEref?format=png']]) {
                     const x=await chrome.runtime.sendMessage({target:'offscreen',type:'classify',url:'https://pbs.twimg.com/media/'+u+'&name=small'});
                     o[n]=x.marqo&&x.marqo.nsfw; } return o;})()""")
                diff = max(abs(got[k] - ref["nsfw"][k]) for k in ref["nsfw"])
                R.check("F11: Marqoの結果が元のPython実装と一致（差0.03以内）", diff < 0.03, {"ext": got, "ref": ref["nsfw"], "diff": round(diff, 4)})
            else:
                print("SKIP F11: Marqo モデルが同梱されていません")

            # F2 要確認フォルダ：しきい値の近くに来るよう設定して保存
            land_p = await sw.evaluate("""(async()=>{const c=await classify('https://pbs.twimg.com/media/LANDf001?format=jpg&name=small'); return xsaverBaseProb(c, await getSettings());})()""")
            await setcfg({"threshold": round(land_p + 0.05, 3), "reviewBand": 0.1, "useReview": True})
            await hover("#land")
            e = await entry("LANDf001")
            R.check("F2: 判定が微妙な画像は 要確認 フォルダへ", e and e["label"] == "Review" and "/要確認/" in e["filename"], e and e["filename"])
            old_id = e and e.get("downloadId")
            await setcfg({"threshold": 0.5, "reviewBand": 0.2})

            # F3 保存済み(要確認)に 2 キー → NSFW へ移動、元ファイルは削除
            await hover("#land", "2")
            e = await entry("LANDf001")
            R.check("F3: 2キーで NSFW に移動", e and e["label"] == "NSFW" and "/NSFW/" in e["filename"] and e["verified"], e and e["filename"])
            R.check("F3: 要確認からの仕分けは「間違い」に数えない", e and not e.get("corrected"))
            st = await dl_state(old_id) if old_id is not None else None
            R.check("F3: 元の要確認ファイルは削除される", st is None or st.get("exists") is False, st)
            # （テスト環境ではファイル名が置き換わるので、URLで数える）
            alive = await sw.evaluate("chrome.downloads.search({}).then(r=>r.filter(d=>d.exists&&d.state==='complete'&&d.url.includes('LANDf001')).length)")
            R.check("F3: ディスク上に残るのは移動後の1ファイルだけ", alive == 1, alive)

            # F4 未保存の画像に 1 キー → SFW として保存（自動判定も記録）
            await hover("#shape", "1")
            e = await entry("SHAPEf002")
            R.check("F4: 1キーで SFW として保存", e and e["label"] == "SFW" and e["verified"] and e["autoLabel"] in ("SFW", "NSFW", "Review"), e and {k: e[k] for k in ("label", "autoLabel", "verified")})

            # F5 自動SFWの画像を NSFW に直す → 「間違い」に数える
            await hover("#land2", wait=4000)
            e0 = await entry("LANDf003")
            await hover("#land2", "2")
            e = await entry("LANDf003")
            R.check("F5: 自動判定を直すと corrected が付く", e0 and e0["autoLabel"] == "SFW" and e and e["label"] == "NSFW" and e.get("corrected"), e and {k: e.get(k) for k in ("autoLabel", "label", "corrected")})

            # F6 精度表示
            st = await opt.evaluate("chrome.runtime.sendMessage({type:'stats'})")
            R.check("F6: 実測の正解率を計算（確認2枚中1枚正解）", st["checked"] == 2 and st["correct"] == 1 and abs(st["accuracy"] - 0.5) < 1e-9, {k: st[k] for k in ("checked", "correct", "accuracy")})
            await opt.reload(); await opt.wait_for_timeout(1200)
            acc_text = await opt.inner_text("#accuracy")
            R.check("F6: 設定画面に正解率が出る", "50.0%" in acc_text, acc_text)
            minfo = await opt.inner_text("#modelInfo")
            R.check("F6: ダミーのMarqoは判定に使わないと表示", (not dummy) or "ダミー" in minfo, minfo)

            # F7 学習：「水着(Sexy)はSFW」と考える人の確認データ60枚を入れて学習させる
            # 実際のモデル出力に近づけるため、5クラスの確率は合計1になるように作る
            await sw.evaluate("""(async()=>{const p={}; let s=7; const r=()=>{s=(s*16807)%2147483647; return s/2147483647};
               const K=['Neutral','Sexy','Porn','Hentai','Drawing'];
               for(let i=0;i<80;i++){const top=['Neutral','Sexy','Porn','Drawing'][i%4];
                 const raw={}; for(const k of K) raw[k]=0.02+0.15*r(); raw[top]=1.5+3*r();
                 const sum=K.reduce((a,k)=>a+raw[k],0); const n={}; for(const k of K) n[k]=raw[k]/sum;
                 const lab=top==='Porn'?'NSFW':'SFW';
                 p['saved:SYN'+i]={mediaId:'SYN'+i,ext:'jpg',user:'syn',cls:{nsfwjs:n,marqo:{nsfw:.5,dummy:true}},xs:false,p:.5,by:'nsfwjs',
                   autoLabel:lab,label:lab,verified:true,t:i,filename:'X_Saver/x/SYN'+i+'.jpg'};}
               await chrome.storage.local.set(p);})()""")
            pr = await opt.evaluate("chrome.runtime.sendMessage({type:'retrain'})")
            R.check("F7: 確認済みが十分あると個人モデルが有効になる", pr.get("enabled") and pr["cv"]["personal"] >= pr["cv"]["base"], pr.get("cv") or pr.get("reason"))
            R.check("F7: 標準の判定より正確になる（Sexyの扱いを学習）", pr.get("cv") and pr["cv"]["personal"] > pr["cv"]["base"] + 0.1, pr.get("cv"))
            dec = await sw.evaluate("""(async()=>decide({nsfwjs:{Neutral:.06,Sexy:.82,Porn:.05,Hentai:.03,Drawing:.04},marqo:null}, false, await getSettings()))()""")
            R.check("F7: 学習後は水着をSFWと判定", dec["by"] == "personal" and dec["label"] == "SFW", dec)
            await setcfg({"learn": False})
            dec = await sw.evaluate("""(async()=>decide({nsfwjs:{Neutral:.06,Sexy:.82,Porn:.05,Hentai:.03,Drawing:.04},marqo:null}, false, await getSettings()))()""")
            R.check("F7: 学習をオフにすると標準の判定に戻る", dec["by"] != "personal" and dec["label"] == "NSFW", dec)
            await setcfg({"learn": True})

            # F8 振り分けページ
            rv = await ctx.new_page()
            rv.on("pageerror", lambda e: errors.append("review: " + str(e)))
            await rv.goto(f"chrome-extension://{ext}/review.html?filter=all"); await rv.wait_for_timeout(1200)
            n_cards = await rv.locator(".card").count()
            R.check("F8: 振り分けページに一覧が出る", n_cards >= 83, n_cards)
            R.check("F8: サムネイルは初期状態でぼかす", await rv.evaluate("document.body.classList.contains('blur')"))
            await rv.click('.tabs button[data-filter="corrected"]'); await rv.wait_for_timeout(800)
            R.check("F8: 「直したもの」タブに1枚", await rv.locator(".card").count() == 1)
            await rv.click('.tabs button[data-filter="all"]'); await rv.wait_for_timeout(800)
            card = rv.locator('.card[data-id="SHAPEf002"]')
            await card.locator("button", has_text="NSFW").click(); await rv.wait_for_timeout(3500)
            e = await entry("SHAPEf002")
            R.check("F8: ボタンで移動できる", e and e["label"] == "NSFW" and "/NSFW/" in e["filename"], e and e["filename"])

            # F9 権限：X のページ（コンテンツスクリプト）からは一覧・移動・統計を呼べない
            chk = await sw.evaluate("""[isExtensionPage({id:chrome.runtime.id,url:'https://x.com/home',tab:{id:1}}),
                                        isExtensionPage({id:chrome.runtime.id,url:chrome.runtime.getURL('options.html'),tab:{id:2}}),
                                        isExtensionPage({id:'other',url:chrome.runtime.getURL('options.html')})]""")
            R.check("F9: Xのページからの依頼は拡張機能の画面として扱わない", chk == [False, True, False], chk)
            bad = await sw.evaluate("""(async()=>{const out=[]; for (const [m,l] of [['../x','NSFW'],['LANDf001','Porn'],['NOPE','SFW']]) {
                 try { out.push((await relabel(m,l)).status); } catch(e){ out.push('err'); } } return out;})()""")
            R.check("F9: 不正なIDやラベルでの移動は拒否", bad == ["err", "err", "notfound"], bad)

            # F10 ファイル名の重複・既存設定との互換：v1.1 形式の履歴（downloadId・ext なし）も直せる
            await sw.evaluate("chrome.storage.local.set({'saved:LEGACYf9':{label:'SFW',filename:'X_Saver/SFW/old_1_1.jpg',t:1}})")
            r = await sw.evaluate("relabel('LEGACYf9','NSFW')")
            R.check("F10: v1.1 の履歴も移動できる", r.get("status") == "relabeled" and "/NSFW/" in r.get("filename", ""), r)

            R.check("ページのJSエラーなし", not errors, errors[:3])
            await opt.set_viewport_size({"width": 760, "height": 1400})
            await opt.reload(); await opt.wait_for_timeout(1200)
            await opt.screenshot(path=os.path.join(H.WORK, "options_v12.png"), full_page=True)
            await rv.set_viewport_size({"width": 1100, "height": 800})
            await rv.evaluate("document.getElementById('blur').click()")
            await rv.click('.tabs button[data-filter="review"]'); await rv.wait_for_timeout(300)
            await rv.click('.tabs button[data-filter="all"]'); await rv.wait_for_timeout(1500)
            await rv.screenshot(path=os.path.join(H.WORK, "review_v12.png"))
            await browser.close()
    finally:
        proc.terminate()
    ok = R.summary()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
