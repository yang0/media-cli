@echo off
cd /d E:\projectHome\media-cli\dola\cli
node src/cli.js video submit --prompt "Slow camera pan right across a simple stock price line chart on a floating white card, the line trending gently downward toward a large padlock icon at the far right marking a future date, subtle data points pulsing, flat 3D clay render, soft studio light, no text, no letters" --duration 5 --aspect-ratio 16:9 --request-id jiejin-v2-shot01-002 --file "E:\projectHome\media-cli\chatgpt\cli\downloads\jiejin-v2\shot-01.png" --json > E:\projectHome\media-cli\dola\cli\submit-test-01.json 2>&1
type E:\projectHome\media-cli\dola\cli\submit-test-01.json
