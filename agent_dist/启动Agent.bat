@echo off
rem MusicFinder Douyin Evidence Agent - one click start (Windows)
cd /d "%~dp0"
if not exist node_modules call npm install
set GATEWAY_WS=wss://agent-gateway-292238-8-1463776169.sh.run.tcloudbase.com/ws/agent
set GATEWAY_HTTP=https://agent-gateway-292238-8-1463776169.sh.run.tcloudbase.com
set AGENT_TOKEN=demo-token-win
set AGENT_ID=win-study
node index.js
pause
