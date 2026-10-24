# One POS — start the local development stack.
#   Database: Docker (Postgres on port 5434)
#   API:      http://localhost:5090   (applies migrations on start)
#   Web app:  http://localhost:3100   (sign in: admin / admin123 on a fresh database)
# Stop with Ctrl+C in each window; stop the database with:  docker compose stop db

$root = $PSScriptRoot
docker compose -f "$root\docker-compose.yml" up -d db
Start-Process powershell -ArgumentList "-NoExit", "-Command", "dotnet run --project '$root\src\OnePos.Api' --launch-profile http"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\web'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"
Write-Host "Starting… open http://localhost:3100 in a few seconds."
