const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/85E789A61D91C72E89AB8FB324F331E6');

ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
  
  // 监听所有Network事件
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Network.requestWillBeSent') {
      const req = msg.params.request;
      if (req.url.includes('generate') || req.url.includes('aigc')) {
        console.log('\\n=== Request found ===');
        console.log('URL:', req.url);
        console.log('Method:', req.method);
        console.log('Headers:', JSON.stringify(req.headers, null, 2));
        if (req.postData) {
          console.log('\\nBody:');
          console.log(req.postData);
        }
      }
    }
  });
  
  // 触发生成
  setTimeout(() => {
    ws.send(JSON.stringify({
      id: 2,
      method: 'Runtime.evaluate',
      params: {
        expression: \
          const textarea = document.querySelector('textarea');
          if (textarea) {
            textarea.value = '大家好，我是数字人';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
          setTimeout(() => {
            for (const btn of document.querySelectorAll('button')) {
              const t = btn.innerText || btn.textContent || '';
              if (t.includes('生成') && !t.includes('去查看')) {
                console.log('Clicking:', t);
                btn.click();
                break;
              }
            }
          }, 500);
          'triggered'
        \
      }
    }));
  }, 1000);
});

setTimeout(() => {
  console.log('\\n=== Closing after 10s ===');
  ws.close();
  process.exit(0);
}, 10000);
