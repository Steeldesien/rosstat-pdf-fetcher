# Rosstat PDF downloader

Downloads public Rosstat reports and passes the original PDF to a private Cloudflare delivery coordinator. The menu includes only report types verified to have downloadable PDF releases.

The standard GitHub-hosted Linux runner contains no Telegram token or chat ID. No state branches, PDF artifacts, uploaded logs, or persistent caches are created. Runner logs contain only generic status. The public workflow input is an opaque random job identifier.

Private Cloudflare state holds publication schedules, Telegram configuration, command deduplication and delivery history. A minute timer starts a GitHub job only when a publication is due or `/latest` is requested. While a release is pending, checks run once per minute every evening from 21:00 inclusive to 23:00 exclusive, Asia/Yekaterinburg (UTC+5). Outside this daily window the downloader performs one check per hour and exits; it does not keep an idle GitHub job running between hourly checks. The next evening restores minute checks automatically. Late releases remain pending across days and publication weeks. Reporting-period matching prevents a delayed report from closing a newer week's task. Successful delivery stops that release's checks.

Cloudflare sends the document to the authorized private Telegram chat. The runner needs only the protected GitHub Actions secrets `BROKER_URL` and `BROKER_TOKEN`. The coordinator additionally needs `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_SECRET` and a repository-scoped GitHub Actions dispatch token. Never put secret values in source, workflow inputs or configuration committed to Git.

Rosstat HTTPS uses the bundled CA trust file; validation stays enabled. The trust file includes the Russian Trusted CA chain. Every source redirect is checked before it is followed. Only HTTPS Rosstat hostnames are accepted, and the downloaded document must begin with `%PDF-` and be at most 25 MB.

Explicit publication-calendar dates take precedence. After the configured calendar ends, the regular weekly window is Wednesday at 21:00 Asia/Yekaterinburg. Holiday changes should be added as explicit calendar dates.

Standard GitHub Actions runners in public repositories are free of monthly execution-minute billing; platform limits and launch delays still apply. Cloudflare Free retains daily quotas. No paid plan is required.

Inflation PDFs are named with the complete reporting range, for example `Инфляция_03.11.2026-09.11.2026.pdf`. The range is taken from the release title, including month and year transitions. GDP quarter releases use the quarter's date range, for example `ВВП_01.07.2026-30.09.2026.pdf`.

A new inflation target starts only on its configured Wednesday. After successful delivery, no daily inflation checks or automatic resends occur before the next Wednesday target. Checks on later days apply only to an outstanding delayed release. Explicit one-off tests such as GDP have their own independent calendar date.

To switch delivery to a group, the owner sends `/connect@YourBotUsername` in that group. The owner is identified by the original private Telegram ID configured in the coordinator, not by a group title or a forwarded message. Only the owner can change the destination. `/latest` is accepted in the connected group and in the owner's private chat; PDFs go to the connected destination. Sending `/connect` in the owner's private chat restores private delivery. A forum topic is remembered when the connection command is sent in that topic. The destination ID stays in private Cloudflare storage and is never included in runner claims or public workflow inputs. Bots need permission to send messages and documents in the chosen group.

Run local checks with `python -m unittest discover -v` and `node --test coordinator.test.mjs`.

## Optional analysis

Set the private Worker secret `GEMINI_API_KEY`, select an available Free model with `GEMINI_MODEL`, and enable `ANALYSIS_ENABLED=true` only after a private real-PDF test. No AI credential is given to GitHub Actions. The provider receives public Rosstat documents and a fixed analysis prompt; Telegram identities and group messages are excluded.

With analysis enabled, a report command first offers inline period buttons and a PDF-only option. Weekly reports offer the latest release and rolling 1, 2 or 3 months. Monthly reports offer the latest release and 3, 6 or 12 reporting months. GDP offers the latest release and 6 or 12 months of one comparable publication series. Ranges end at the newest available reporting period, not the command date. "Three months" is deliberately not labelled a calendar quarter. The PDF arrives before the analysis.

Python parses actual report periods, backfills missing documents from the official news archive, checks continuity, hashes the PDF bytes and extracts page text. Incomplete windows are reported rather than analysed as complete periods. Backfill requests are bounded and spaced; no additional scheduled polling is introduced. Native PDFs accompany extracted text so the model can inspect tables. Quoted key metrics are checked against extracted source pages before sending an answer. Cumulative releases are not added together.

The application cache resides in private Durable Object storage. A key includes the report, mode, exact interval and content hashes of all selected and baseline documents. New releases, corrections and changed source sets produce a new key. Identical requests, including concurrent requests, reuse the stored answer without a model request. Ready answers survive redeployments; PDFs are not retained in the cache. Unknown outcomes after an interrupted provider call are held for review instead of automatically submitted again. Explicit provider refusals may be retried on a later user request. Model errors do not prevent PDF delivery.

Analysis checks: `node --test coordinator.test.mjs analysis.test.mjs` and `python -m unittest discover -v`.

## Manual report menu

`/inflation` weekly inflation, `/cpi` monthly CPI, `/gdp` GDP, `/fuel` weekly oil-product prices, `/gasoline` monthly gasoline prices, `/industry` industrial production, `/ppi` producer prices, `/finance` company financial results, `/business` business activity, `/wages` wage arrears. The old `/latest` remains an alias for weekly inflation and is omitted from the menu.

Each command checks the official RSS and the PDF catalogue and downloads the newest available reporting period again. No previously received PDF is sent as a substitute for that check. Additional menu types do not add automatic monitoring targets. The social-economic report catalogue is not presented as a directly downloadable PDF.

PDF captions show the official news publication timestamp and the completed-download timestamp, to seconds in Asia/Yekaterinburg (UTC+5). For archive-only files without a news timestamp, publication time is explicitly unavailable; the catalogue's file date is shown separately and is not presented as an exact publication time.
