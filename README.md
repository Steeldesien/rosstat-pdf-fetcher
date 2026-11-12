# Rosstat PDF downloader

Downloads public Rosstat weekly inflation releases and passes the original PDF to a private Cloudflare delivery coordinator.

The standard GitHub-hosted Linux runner contains no Telegram token or chat ID. No state branches, PDF artifacts, uploaded logs, or persistent caches are created. Runner logs contain only generic status. The public workflow input is an opaque random job identifier.

Private Cloudflare state holds publication schedules, Telegram configuration, command deduplication and delivery history. A minute timer starts a GitHub job only when a publication is due or `/latest` is requested. While a release is pending, checks run once per minute every evening from 21:00 inclusive to 23:00 exclusive, Asia/Yekaterinburg (UTC+5). Outside this daily window the downloader performs one check per hour and exits; it does not keep an idle GitHub job running between hourly checks. The next evening restores minute checks automatically. Late releases remain pending across days and publication weeks. Reporting-period matching prevents a delayed report from closing a newer week's task. Successful delivery stops that release's checks.

Cloudflare sends the document to the authorized private Telegram chat. The runner needs only the protected GitHub Actions secrets `BROKER_URL` and `BROKER_TOKEN`. The coordinator additionally needs `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_SECRET` and a repository-scoped GitHub Actions dispatch token. Never put secret values in source, workflow inputs or configuration committed to Git.

Rosstat HTTPS uses the bundled CA trust file; validation stays enabled. The trust file includes the Russian Trusted CA chain. Every source redirect is checked before it is followed. Only HTTPS Rosstat hostnames are accepted, and the downloaded document must begin with `%PDF-` and be at most 25 MB.

Explicit publication-calendar dates take precedence. After the configured calendar ends, the regular weekly window is Wednesday at 21:00 Asia/Yekaterinburg. Holiday changes should be added as explicit calendar dates.

Standard GitHub Actions runners in public repositories are free of monthly execution-minute billing; platform limits and launch delays still apply. Cloudflare Free retains daily quotas. No paid plan is required.

Inflation PDFs are named with the complete reporting range, for example `Инфляция_03.11.2026–09.11.2026.pdf`. The range is taken from the release title, including month and year transitions.

Run local checks with `python -m unittest discover -v` and `node --test coordinator.test.mjs`.
