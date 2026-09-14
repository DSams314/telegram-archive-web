# Putting Telegram Archive on GitHub — a plain-language guide

This explains, step by step, what GitHub is, what it will do with this project,
and exactly what each command does. **Nothing in here has been done yet.** The
project exists only on your Mac. You decide if and when any of it happens.

---

## What GitHub is, in one paragraph

GitHub is a website that stores a copy of a project's code and its history of
changes. Here it would do three jobs: keep a backup of the code, run the
automatic tests on fresh machines every time the code changes, and (only if you
switch it on) host the website version of Telegram Archive.

## What would become public — and what would not

A GitHub Pages website on a free account needs a **public** repository, so the
code is visible to anyone. That is normal for privacy tools: it is what lets
people check the privacy claims for themselves.

| Public on GitHub | Never leaves your Mac |
|---|---|
| The program's code | Your chats and exports (`Backups/`) |
| The tests and tools | Your settings, index and logs (`data/`) |
| The export guide and README | Built files (`dist/`, `site/`) |
| `site-config.json` (the fund bar) | Anything listed in `.gitignore` |

Before any of this, every file has already been checked for your name, your
account name, your Telegram ID, and the names and IDs of everyone in your
archive. Several were found and replaced with invented ones. That check now
runs automatically before every commit (see *The safety net*, below).

## Protecting your identity as the developer

A public repository shows **which GitHub account owns it**, and the website's
address includes that account name: `accountname.github.io/telegram-archive`.

1. **Use a separate GitHub account** for this project, with a name that isn't
   yours. Or make a free *organization* and put the project there.
2. **Turn on two-factor sign-in** for that account (Settings › Password and
   authentication). Whoever controls the account controls what every visitor to
   the website loads, so this matters more than usual.
3. **Keep your email out of the history.** GitHub gives every account a private
   address like `12345+accountname@users.noreply.github.com` (Settings › Emails).
   Your Mac has no git name or email set, so nothing personal is added by default.
4. **Check the donation page before linking it.** Some services (PayPal in
   particular) show your legal name to anyone who donates.

## The steps, and what each one does

You would run these yourself, one at a time. Nothing happens until you do.

**1. Install GitHub's command-line tool.** Adds a program called `gh`. Doesn't
contact your GitHub account.

```bash
brew install gh
```

**2. Sign in.** Opens a browser page where you approve access. Your password
never passes through Claude. Sign in with the separate account from above.

```bash
gh auth login
```

**3. Create the repository and upload the code.** Makes an empty repository on
GitHub, then uploads the project and its history. From here, the code is visible
on GitHub.

```bash
gh repo create telegram-archive --public --source=. --push
```

**4. (Later, only when you want the website live) switch publishing on.** Two
settings on the GitHub website, both reversible:
- *Settings › Pages › Build and deployment › Source*: choose **GitHub Actions**.
- *Settings › Secrets and variables › Actions › Variables*: add `PUBLISH_SITE`
  with the value `true`.

About a minute later the website is at `https://accountname.github.io/telegram-archive/`.

### How to undo each step

| To undo | Do this |
|---|---|
| Take the website down | Set `PUBLISH_SITE` to `false`, then *Settings › Pages › Unpublish site* |
| Hide the code again | *Settings › General › Change visibility* (this also stops the website) |
| Remove it all from GitHub | *Settings › General › Delete this repository* |
| Sign `gh` out of your account | `gh auth logout` |

None of these touch the copy on your Mac.

## What happens automatically once it's on GitHub

- **Every upload runs the tests** (`.github/workflows/tests.yml`) on fresh Mac,
  Windows and Linux machines, and walks through the website in a real Chrome
  browser with an invented archive. It checks that nothing but the site's own
  files is ever requested from the web. You get a green tick or a red cross.
  Nothing is published.
- **Publishing** (`.github/workflows/publish.yml`) runs only when publishing is
  switched on, and only after every test has passed.

## Updating the fund bar or the donation link

No commands needed; do it all on the GitHub website:

1. Open the repository, click **site-config.json**, then the pencil icon.
2. Change `"raised"` to the new total (numbers only, no `$`), or put your
   donation page in `"donate_url"` (it must start with `https://`).
3. Click **Commit changes**.

The tests check the file is valid first. If it is, the website updates by itself
within a minute or two. If you make a typo, the check fails and the website keeps
showing the old numbers rather than breaking.

## What Claude will and won't do

- **Won't** create a repository, upload, publish, or change any GitHub setting
  without you asking for that specific thing in the conversation.
- **Will**, when asked, show you exactly which files and changes an upload
  contains before it happens.
- **Can't** see your GitHub password or approve sign-ins: step 2 happens in your
  browser, between you and GitHub.

## The safety net

A check runs every time a change is saved into the project's history
(`tools/privacy_audit.py`). It works out, from your own computer, the names that
must never appear — your account name, your Telegram ID, and every chat and
contact name in your archive — without ever writing that list down. It refuses
the save if any of them appear in the code. It also flags email addresses,
home-folder paths and anything shaped like a real Telegram user ID.

Run it by hand any time:

```bash
python3 tools/privacy_audit.py
```
