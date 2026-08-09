@echo off
cd /d E:\projectHome\media-cli\dola\cli
node src/cli.js worker status --json > E:\projectHome\media-cli\dola\cli\worker-status.json 2>&1
type E:\projectHome\media-cli\dola\cli\worker-status.json
