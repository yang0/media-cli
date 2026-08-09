@echo off
cd /d E:\projectHome\media-cli\dola\cli
node src/cli.js video generate --prompt "The padlock pops open and the thick chain snaps apart, chain links float apart gently in slow motion, soft studio lighting, flat 3D clay render style, smooth subtle camera push-in, stable composition, no text, no letters" --duration 5 --aspect-ratio 16:9 --request-id jiejin-v2-shot05-002 --file "E:\projectHome\media-cli\chatgpt\cli\downloads\jiejin-v2\shot-05.png" --json > E:\projectHome\media-cli\dola\cli\i2v-test-002.json 2>&1
type E:\projectHome\media-cli\dola\cli\i2v-test-002.json
