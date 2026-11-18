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

Weekly inflation can use Cloudflare Workers AI instead of Gemini. Configure `ai.binding=AI`, `ANALYSIS_PROVIDER=workers-ai`, `WORKERS_AI_MODEL=@cf/openai/gpt-oss-120b`, and `WORKERS_AI_FACTS=true` in the private Wrangler configuration. This is Cloudflare-hosted inference and does not use a ChatGPT account or Codex quota. Only explicitly allowlisted models are accepted; no paid-model fallback is configured. Stay on Workers Free to retain the platform's hard daily free-allocation limit.

For this route, code extracts exact CPI quotes, compounds every selected weekly index, or reads the complete official historical goods calculations. The model receives the resulting small facts object and writes only a short narrative; numeric claims and changes of reporting base in that narrative are rejected. Metrics and numerical changes are constructed by code and checked against source pages. Other report kinds retain Gemini until equivalent deterministic extraction is validated. Existing ready analyses and image caches remain valid. Provider token usage and an estimated Neuron cost are stored with new Workers AI results. Private `workers-ai-preview` checks use a separate cache and do not send Telegram messages.

With `WORKERS_AI_RICH_WEEKLY=true`, the latest weekly inflation release uses all extracted PDF pages plus a verified catalog of headline indices and the weekly column of commodity/service tables. The model writes a short food, fuel/goods and services report and conclusion, referencing catalog IDs. Code substitutes changes and source-page references; unsupported raw figures and unknown IDs are rejected. This format does not infer weighted contributions or economic causes from individual price changes. The upgrade has a versioned application cache key. Its private preview and production share the validated generation cache, so enabling a tested report does not generate it again. Rolling-period analyses retain their existing calculation route.

Set the private Worker secret `GEMINI_API_KEY`, select an available Free model with `GEMINI_MODEL`, and enable `ANALYSIS_ENABLED=true` only after a private real-PDF test. No AI credential is given to GitHub Actions. The provider receives public Rosstat documents and a fixed analysis prompt; Telegram identities and group messages are excluded.

With analysis enabled, a report command first offers inline period buttons and a PDF-only option. Weekly reports offer the latest release and rolling 1, 2 or 3 months. Monthly reports offer the latest release and 3, 6 or 12 reporting months. GDP offers the latest release and 6 or 12 months of one comparable publication series. Ranges end at the newest available reporting period, not the command date. "Three months" is deliberately not labelled a calendar quarter. The PDF arrives before the analysis.

Python parses actual report periods, backfills missing documents from the official news archive, checks continuity, hashes the PDF bytes and extracts page text. Incomplete windows are reported rather than analysed as complete periods. Backfill requests are bounded and spaced; no additional scheduled polling is introduced. Native PDFs accompany extracted text so the model can inspect tables. Quoted key metrics are checked against extracted source pages before sending an answer. Cumulative releases are not added together.

The application cache resides in private Durable Object storage. A key includes the report, mode, exact interval and content hashes of all selected and baseline documents. New releases, corrections and changed source sets produce a new key. Identical requests, including concurrent requests, reuse the stored answer without a model request. Ready answers survive redeployments; PDFs are not retained in the cache. Unknown outcomes after an interrupted provider call are held for review instead of automatically submitted again. Explicit provider refusals may be retried on a later user request. Model errors do not prevent PDF delivery.

Provider refusals retain only safe diagnostics in private storage: HTTP status, a restricted provider reason enum and a classification such as quota, missing model or denied access. Request credentials and raw error bodies are not stored. The owner-only `gemini-probe` endpoint makes one minimal connectivity request without PDFs or Telegram sends; it cannot reconstruct the reason for historical failures recorded before these diagnostics existed.

Analysis checks: `node --test coordinator.test.mjs analysis.test.mjs` and `python -m unittest discover -v`.

Telegram delivery uses a concise view of each stored analysis: a short conclusion, up to four key figures prioritising the newest release, two or three changes and one main limitation. The body is bounded to 3,300 characters so the timestamp footer fits in the same Telegram message. Older stored analyses are compacted locally without another model request. The webhook must subscribe to both `message` and `callback_query` updates for inline buttons to work.

Successful analysis delivery also sends a square PNG card using a burgundy, white and dark grey palette. Python/Pillow and Matplotlib render it on the existing runner without an image-generation service. Inflation charts use the actual PDF's headline indices and comparable commodity table rows, converted to percentage changes with Decimal arithmetic. A single release produces one observed point rather than invented history; range charts identify the baseline separately. Unsupported chart series are explicitly marked as unavailable. The existing concise text is retained.

The private coordinator caches Telegram photo identifiers per analysis and card-template version. Repeated requests reuse the photo without another AI request or image render. Card upload is permitted only to the runner owning the completed matching analysis. A card failure retains the already delivered PDF and text. No PNG artifacts, additional credentials or image-generation quotas are introduced.

Range cards use range-specific calculations rather than repeating the latest-release snapshot. With complete PDFs, weekly and commodity indices are compounded across every selected week; the baseline week is excluded from the calculation. The chart starts at zero on the baseline date and shows cumulative change. These are explicitly labelled chain estimates, not official calendar-month CPI. Versioned range image keys invalidate the earlier snapshot cards without invalidating the saved AI analysis.

For inflation archive gaps, after a bounded PDF archive search, the downloader can use the official `nedel_Ipc.xlsx` weekly goods indices. All observations through the newest PDF date must be present; goods missing any selected observation are excluded. This source does not contain aggregate CPI and is never averaged to invent one. If baseline and latest PDFs with the same year-to-date base are available, the period aggregate estimate is calculated from their index ratio; otherwise aggregate period CPI is explicitly unavailable. The current PDF and optional baseline remain source documents, and the model receives the official table plus labelled deterministic calculations. The source links, coverage, week count and method are shown in the analysis/card. `archive_supplement.json` contains only individually verified public PDF links absent from the main catalogue.

## Manual report menu

`/inflation` weekly inflation, `/cpi` monthly CPI, `/gdp` GDP, `/fuel` weekly oil-product prices, `/gasoline` monthly gasoline prices, `/industry` industrial production, `/ppi` producer prices, `/finance` company financial results, `/business` business activity, `/wages` wage arrears. The old `/latest` remains an alias for weekly inflation and is omitted from the menu.

Each command checks the official RSS and the PDF catalogue and downloads the newest available reporting period again. No previously received PDF is sent as a substitute for that check. Additional menu types do not add automatic monitoring targets. The social-economic report catalogue is not presented as a directly downloadable PDF.

PDF captions show the official news publication timestamp and the completed-download timestamp, to seconds in Asia/Yekaterinburg (UTC+5). For archive-only files without a news timestamp, publication time is explicitly unavailable; the catalogue's file date is shown separately and is not presented as an exact publication time.

Scheduled jobs create one progress message in the connected chat/topic when their start time becomes due. The same message is edited from search to downloading to downloaded before the PDF is sent. Source or dispatch errors edit it to an error, and the next actual retry restores the search state. An unpublished release remains in search and retains the existing minute/hour polling cadence; repeated checks do not create or edit duplicate unchanged statuses. Status message identifiers and destinations stay in private coordinator storage. A lost initial Telegram acknowledgement is held instead of creating duplicate messages, and status failures never block PDF delivery. A failed scheduled analysis updates that same message to explain that the PDF was delivered but analysis failed.
# Optional private calculation engine

The downloader can load a separately maintained private calculation repository for weekly-release reports. Only the generic transport is public. Configure the Actions variable `INFLATION_ENGINE_REPOSITORY`, a repository-specific SSH deploy key in the `INFLATION_ENGINE_DEPLOY_KEY` secret, and the coordinator feature flag `INFLATION_ENGINE_ENABLED`. The calculation repository supplies `bot_bridge.py` and `requirements.txt`.

Private checkout happens only after a source PDF has arrived and an uncached calculation is required. Source data and calculations are persisted only in that private repository. No private source or report files are uploaded as Actions artifacts or saved in public Actions caches. Telegram file IDs and the private coordinator cache reuse ready analyses and all three report files.

Native engine reports represent one weekly release; existing rolling-period analysis and other statistical reports retain their own selection and calculation paths.

# Pre-release delivery

The private coordinator starts the Wednesday forecast at 14:00 Moscow time. The private engine preserves the original model, renders a forecast PNG and two static HTML files, and saves the forecast before delivery. The forecast is explicitly distinguished from the later Rosstat actual release. The accompanying message contains the forecast and period; neural commentary is not published as chat text.

Workers AI explains only the supplied frozen forecast factors. Commentary is cached separately from actual-release analysis; successful and uncertain requests are not automatically submitted again. The PNG is rendered by code, not an image generation API. Private dry runs validate all three files and the analysis without Telegram delivery.

With `REPORT_ARTIFACTS_ONLY=true`, the source Rosstat PDF remains an internal processing input. Its dated caption is sent as a plain announcement, followed by generated report attachments; separate neural narrative messages are suppressed. This policy does not alter report calculations or embedded report commentary. The PDF-only menu option is hidden under this policy.
