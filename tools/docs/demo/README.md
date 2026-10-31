# Manual screenshots

Screenshots in `docs/manual/images/` come from a throwaway demo copy of One POS with made-up data ("Marina Grill · Dubai Marina"),
never from live, test or anyone's own database.

1. Database: `docker run -d --name onepos-docs-db -e POSTGRES_DB=onepos -e POSTGRES_USER=onepos_owner -e POSTGRES_PASSWORD=onepos_owner_dev -p 5440:5432 postgres:17`
2. API (Git Bash, repo root):
   `ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://localhost:5091 ConnectionStrings__Owner="Host=127.0.0.1;Port=5440;Database=onepos;Username=onepos_owner;Password=onepos_owner_dev" ConnectionStrings__App="Host=127.0.0.1;Port=5440;Database=onepos;Username=onepos_app;Password=onepos_app_dev" DataProtection__Keys=<temp dir> Images__Root=<temp dir> dotnet run --project src/OnePos.Api --no-launch-profile`
3. Web: `cd web; ONEPOS_API_URL=http://localhost:5091 npx next dev -p 3101`
4. `cd tools/docs/demo; npm i --no-save playwright-core@1.56.1; node seed.mjs; node screenshots.mjs; node dialogs.mjs; node technical.mjs`
   (`technical.mjs`: the FACTS screens of the demo FACTS company for the technical docs, and the manual's diagrams as PNGs for the online manual)
5. Convert `shots/*.png` to 1600 px JPEGs in `docs/manual/images/` (diagrams stay PNG), then `node tools/docs/build-docs.mjs --manual` and `node tools/docs/build-docs.mjs`.
   Screens and diagrams also go into the online manual (Claude Doc): upload them to the doc, create a blob per picture, insert `![caption](blob/<id>)` under the step.
6. Remove the demo: stop the API and web, `docker rm -f onepos-docs-db`.
