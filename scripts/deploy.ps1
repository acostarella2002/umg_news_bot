# Deploy this folder to the Oracle server: upload, extract, rebuild and restart the bot (the server keeps its own .env and data/).
param(
  [string]$Server = $env:UMG_SERVER_IP, # public IP of the Oracle VM, kept only on this PC (see README)
  [string]$Key = "$HOME\.ssh\oracle_umg" # private SSH key created during the server setup
)
$ErrorActionPreference = 'Stop' # stop at the first PowerShell error
if (-not $Server) { throw 'server IP missing: set the UMG_SERVER_IP variable (see README) or pass -Server' }
$root = Split-Path $PSScriptRoot -Parent # project folder
$archive = Join-Path $env:TEMP 'umg-news-bot.tgz' # temporary archive
$tar = Join-Path $env:SystemRoot 'System32\tar.exe' # Windows tar (Git's GNU tar mishandles C:\ paths)

# Archive without local-only folders; .env and data/ are never overwritten on the server.
& $tar -czf $archive -C $root --exclude=node_modules --exclude=ssh_umg_bot.txt --exclude=data --exclude=.env --exclude=brain --exclude=.git .
if ($LASTEXITCODE) { throw 'archive creation failed' }
scp -i $Key $archive "ubuntu@${Server}:~/umg-news-bot.tgz" # upload
if ($LASTEXITCODE) { throw 'upload failed' }
ssh -i $Key "ubuntu@$Server" 'mkdir -p ~/umg-news-bot && tar -xzf ~/umg-news-bot.tgz -C ~/umg-news-bot && rm ~/umg-news-bot.tgz && cd ~/umg-news-bot && docker compose up -d --build && docker compose ps'
if ($LASTEXITCODE) { throw 'update on the server failed' }
Remove-Item $archive # clean up
Write-Host "Deployed. Health: http://${Server}:8080/health"
