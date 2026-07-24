import json, urllib.request, websocket, base64
pages=json.load(urllib.request.urlopen('http://127.0.0.1:9223/json'))
page=next(p for p in pages if p.get('url')=='chrome://extensions/')
ws=websocket.create_connection(page['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
ws.send(json.dumps({'id':1,'method':'Page.captureScreenshot','params':{'format':'png','fromSurface':True}}))
while True:
 msg=json.loads(ws.recv())
 if msg.get('id')==1:
  open('E:/projectHome/flow-skill/extensions_page.png','wb').write(base64.b64decode(msg['result']['data']))
  print('wrote extensions_page.png')
  break
ws.close()
