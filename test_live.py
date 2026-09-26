import asyncio
import json
import base64
import websockets

async def run_live_test():
    async with websockets.connect('ws://127.0.0.1:9222/session') as ws:
        msg_id = 1
        async def call(method, params=None):
            nonlocal msg_id
            m = {'id': msg_id, 'method': method, 'params': params or {}}
            msg_id += 1
            await ws.send(json.dumps(m))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get('id') == m['id']:
                    return resp

        try:
            print("1. Creating BiDi session and subscribing to logs...")
            await call('session.new', {'capabilities': {}})
            await call('session.subscribe', {'events': ['log.entryAdded']})

            print("2. Installing extension...")
            inst = await call('webExtension.install', {
                'extensionData': {
                    'type': 'path',
                    'path': r'C:\Users\user\data\0x\aistudio-upload-fixer'
                }
            })
            print("   Extension installed:", inst.get('result'))

            tree = await call('browsingContext.getTree', {})
            ai_ctx = None
            for c in tree['result']['contexts']:
                if 'aistudio.google.com' in c.get('url', ''):
                    ai_ctx = c['context']
                    break
            if not ai_ctx:
                raise Exception("AI Studio context not found!")

            print(f"3. Navigating AI Studio tab (ctx: {ai_ctx})...")
            await call('browsingContext.navigate', {
                'context': ai_ctx,
                'url': 'https://aistudio.google.com/prompts/new_chat',
                'wait': 'interactive'
            })

            # Wait for initialization
            print("4. Waiting for page initialization...")
            await asyncio.sleep(4)

            # Check store hooking status
            status = await call('script.evaluate', {
                'expression': '''(() => {
                    return {
                        hasStore: !!window.__aistudioUploadFixerStore,
                        storeFHooked: !!window.__aistudioUploadFixerStore?.F?.__uploadFixerHooked,
                        url: window.location.href
                    };
                })()''',
                'target': {'context': ai_ctx},
                'awaitPromise': True,
                'returnByValue': True
            })
            print("   Hook status:", status.get('result', {}).get('result'))

            print("\n=== PHASE 1: First Drop (README.md, test.js, Dockerfile) ===")
            print("README.md & test.js should pass as-is. Dockerfile should be intercepted in memory and healed to Dockerfile.txt.")
            js_dispatch = """(() => {
                const dt = new DataTransfer();
                const f1 = new File(["# README\\nThis is a test readme file."], "README.md", { type: "text/markdown" });
                const f2 = new File(["function test() { return 42; }"], "test.js", { type: "text/javascript" });
                const f3 = new File(["FROM alpine:latest\\nRUN apk add curl\\nENTRYPOINT [\\"sh\\"]"], "Dockerfile", { type: "" });
                dt.items.add(f1);
                dt.items.add(f2);
                dt.items.add(f3);

                const target = document.querySelector("[msglobalfiledragdrop]") || document.body;
                const evt = new DragEvent("drop", {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    dataTransfer: dt
                });
                target.dispatchEvent(evt);
                return "Drop event dispatched with 3 files";
            })()"""

            eval_res = await call('script.evaluate', {
                'expression': js_dispatch,
                'target': {'context': ai_ctx},
                'awaitPromise': True,
                'returnByValue': True
            })
            print("   Dispatch result:", eval_res.get('result', {}).get('result'))

            # Listen to logs for 10 seconds while files are processed and backend responds
            end_time = asyncio.get_event_loop().time() + 10
            while asyncio.get_event_loop().time() < end_time:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    msg = json.loads(raw)
                    if msg.get('method') == 'log.entryAdded':
                        p = msg['params']
                        text = p.get('text', '')
                        lvl = p.get('level', '')
                        if 'AI Studio Upload Fixer' in text or 'counting tokens' in text or 'Dockerfile' in text or lvl == 'error':
                            print(f"   [{lvl.upper()}] {text}")
                except asyncio.TimeoutError:
                    pass

            print("\n=== PHASE 2: Inspecting Phase 1 Chips ===")
            check_res = await call('script.evaluate', {
                'expression': '''(() => {
                    const chips = Array.from(document.querySelectorAll('.prompt-media-item-container'));
                    return chips.map(c => {
                        const name = c.querySelector('.name')?.textContent?.trim() || '';
                        const status = c.querySelector('.token-status-error, [data-test-id="status"]')?.textContent?.trim() || '';
                        const allText = c.textContent.trim().replace(/\\s+/g, ' ');
                        return { name, status, allText };
                    });
                })()''',
                'target': {'context': ai_ctx},
                'awaitPromise': True,
                'returnByValue': True
            })
            chips = check_res.get('result', {}).get('result', {}).get('value', [])
            print(f"   Found {len(chips)} chips:")
            for chip in chips:
                vals = dict((x[0], x[1]['value']) for x in chip['value'])
                print("   *", vals)

            print("\n=== PHASE 3: Second Drop (Session Learning Verification) ===")
            print("Dropping another Dockerfile (type 'dockerfile' was learned in Phase 1).")
            print("Expected: Pre-filtered to Dockerfile.txt ON INPUT with ZERO duplicate network upload!")

            js_dispatch2 = """(() => {
                const dt = new DataTransfer();
                const f4 = new File(["FROM ubuntu:24.04\\nRUN apt update && apt install -y python3"], "Dockerfile", { type: "" });
                dt.items.add(f4);

                const target = document.querySelector("[msglobalfiledragdrop]") || document.body;
                const evt = new DragEvent("drop", {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    dataTransfer: dt
                });
                target.dispatchEvent(evt);
                return "Drop event dispatched with second Dockerfile";
            })()"""

            eval_res2 = await call('script.evaluate', {
                'expression': js_dispatch2,
                'target': {'context': ai_ctx},
                'awaitPromise': True,
                'returnByValue': True
            })
            print("   Dispatch 2 result:", eval_res2.get('result', {}).get('result'))

            end_time2 = asyncio.get_event_loop().time() + 6
            while asyncio.get_event_loop().time() < end_time2:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    msg = json.loads(raw)
                    if msg.get('method') == 'log.entryAdded':
                        p = msg['params']
                        text = p.get('text', '')
                        lvl = p.get('level', '')
                        if 'AI Studio Upload Fixer' in text or 'counting tokens' in text or 'Dockerfile' in text:
                            print(f"   [{lvl.upper()}] {text}")
                except asyncio.TimeoutError:
                    pass

            print("\n=== FINAL INSPECTION: All Chips in DOM ===")
            final_res = await call('script.evaluate', {
                'expression': '''(() => {
                    const chips = Array.from(document.querySelectorAll('.prompt-media-item-container'));
                    return chips.map(c => {
                        const name = c.querySelector('.name')?.textContent?.trim() || '';
                        const status = c.querySelector('.token-status-error, [data-test-id="status"]')?.textContent?.trim() || '';
                        const allText = c.textContent.trim().replace(/\\s+/g, ' ');
                        return { name, status, allText };
                    });
                })()''',
                'target': {'context': ai_ctx},
                'awaitPromise': True,
                'returnByValue': True
            })
            final_chips = final_res.get('result', {}).get('result', {}).get('value', [])
            print(f"   Total chips: {len(final_chips)}")
            for chip in final_chips:
                vals = dict((x[0], x[1]['value']) for x in chip['value'])
                print("   *", vals)

            print("\nCapturing native tab screenshot...")
            shot = await call('browsingContext.captureScreenshot', {'context': ai_ctx})
            screenshot_path = r'C:\Users\user\data\0x\aistudio-upload-fixer\live_test_result.png'
            with open(screenshot_path, 'wb') as f:
                f.write(base64.b64decode(shot['result']['data']))
            print(f"Screenshot successfully saved to: {screenshot_path}")

        finally:
            print("\nEnding BiDi session...")
            await call('session.end', {})
            print("Session cleanly ended.")

asyncio.run(run_live_test())
