# Registering the GitLab and GitHub apps

On a team's orchestrator, an owner or an admin connects the organization's GitLab or GitHub in
the browser, with one click on **Integrations**, once whoever runs the orchestrator has
registered an app with that forge. Each app is optional: without it a repository connects with a
token ([Integrations](../user/integrations.md#integrations)). You register the app yourself,
under your own account or your organization's; the orchestrator creates no account and registers
nothing.

## Before you start

- `ORCHESTRATOR_PUBLIC_URL` is the address people reach the orchestrator at. Both apps send the
  browser back to `<ORCHESTRATOR_PUBLIC_URL>/integrations/forge/callback`, and GitLab compares that
  address character for character, so write it exactly as the orchestrator has it, with no
  trailing slash.
- `ORCHESTRATOR_SECRET_KEY` is set: the tokens a connection gets are sealed with it.
- One person's own orchestrator, the one `npm start`, npx and the installer start, needs neither
  app: its GitLab and GitHub cards are one button, **Sign in with GitLab** or **Sign in with
  GitHub**, which runs that person's own `glab` or `gh` browser sign-in. So does a self-hosted
  orchestrator one person runs and only their machine reaches (`ORCHESTRATOR_AUTH=dev-admin`, no
  `ORCHESTRATOR_HOST`, one account). Once a second account exists or it listens beyond this
  machine, the cards connect through the apps below.

Until the app, `ORCHESTRATOR_PUBLIC_URL` and `ORCHESTRATOR_SECRET_KEY` are all set, the forge's
card offers no **Connect with GitLab** or **Connect with GitHub**, and
`GET /api/forge/<gitlab|github>/connection` names what is missing.

## GitLab OAuth application

1. On gitlab.com, open **Applications** in your user settings, or in the settings of the group
   that will own the application.
2. Name it, for instance `TeamHandbook Orchestrator`.
3. **Redirect URI**: `<ORCHESTRATOR_PUBLIC_URL>/integrations/forge/callback`.
4. **Confidential**: ticked. The orchestrator sends the application's secret when it exchanges the
   sign-in and when it renews the token.
5. **Scopes**: `api` alone. No narrower GitLab scope opens merge requests.
6. Save, then copy the **Application ID** and the **Secret**.
7. Set, where the other `ORCHESTRATOR_*` settings are kept ([Configuration](configuration.md#configuration)):

   ```sh
   ORCHESTRATOR_FORGE_GITLAB_CLIENT_ID=<Application ID>
   ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET=<Secret>     # or ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET_FILE
   # ORCHESTRATOR_FORGE_GITLAB_URL=https://gitlab.example.com   only for a GitLab other than gitlab.com
   ```

   Both or neither: one alone stops the start with `set ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET as
   well, or none of ORCHESTRATOR_FORGE_GITLAB_*`.
8. Restart the orchestrator. An owner or an admin presses **Connect with GitLab** on the GitLab
   card on Integrations and signs in on GitLab. The orchestrator renews the token itself before it
   lapses, sending the redirect URI the connection was made with each time: after
   `ORCHESTRATOR_PUBLIC_URL` changes, register the new redirect URI on the application and press
   Connect again, or GitLab refuses the next renewal.

When no GitLab application is set here, the GitLab card offers an owner the organization's own
instead, for a self-managed GitLab: it shows the redirect URI to register there, and takes the
**GitLab address**, the **Application ID** and the **Secret** with **Save application**.

## GitHub App

1. On github.com, open **Settings > Developer settings > GitHub Apps > New GitHub App**, under your
   account or under the organization that will own the app.
2. **GitHub App name**: its URL name (the last part of `https://github.com/apps/<name>`) is
   `ORCHESTRATOR_FORGE_GITHUB_APP_SLUG`.
3. **Homepage URL**: `ORCHESTRATOR_PUBLIC_URL`.
4. **Callback URL**: `<ORCHESTRATOR_PUBLIC_URL>/integrations/forge/callback`.
5. **Request user authorization (OAuth) during installation**: ticked. The orchestrator checks the
   installation with the installer's own sign-in; without it GitHub returns with no sign-in and the
   connection stops with "The sign-in to GitHub was not completed." The installer's token is used
   once and kept nowhere.
6. **Setup URL**: empty. **Redirect on update**: unticked.
7. **Webhook**: active, **Webhook URL** `<ORCHESTRATOR_PUBLIC_URL>/api/hooks/github-app`, and a
   **Secret** of 16 characters or more, the same value as
   `ORCHESTRATOR_FORGE_GITHUB_WEBHOOK_SECRET`. Tick no events: GitHub sends an app its
   installation events (removed, suspended, unsuspended) without them, and those are the ones the
   orchestrator reads. Without the secret the orchestrator refuses every delivery, and hears that
   the app was removed only when it next asks GitHub for a token. An orchestrator GitHub does not
   reach leaves this webhook inactive; the repository webhooks it sets up for push and pull request
   events need that reach too.
8. **Repository permissions**:

   | Permission | Access |
   |---|---|
   | Contents | Read and write |
   | Pull requests | Read and write |
   | Commit statuses | Read and write |
   | Webhooks | Read and write |
   | Issues | Read-only |
   | Checks | Read-only: a request is read with its check runs, and without it the request does not read |
   | Metadata | Read-only (GitHub sets it) |
   | Administration | Read and write, only to create the team's skill repository inside an organization; on a personal account you create that repository yourself |

   The connection's check (`GET /api/forge/github/connection/check`) names which of these the
   installation lacks. Workflows is left off on purpose: a change an agent makes under
   `.github/workflows/` is refused by GitHub and does not open as a request; a person changes the
   repository's CI themselves.
9. **Where can this GitHub App be installed**: **Only on this account** for your own organization,
   **Any account** when other organizations install it.
10. Create the app. On its page, copy the **App ID** and the **Client ID**, press **Generate a new
    client secret** and copy it, and under **Private keys** press **Generate a private key**: the
    browser downloads a `.pem` file.
11. Set:

    ```sh
    ORCHESTRATOR_FORGE_GITHUB_APP_ID=<App ID>
    ORCHESTRATOR_FORGE_GITHUB_APP_SLUG=<the app's URL name>
    ORCHESTRATOR_FORGE_GITHUB_CLIENT_ID=<Client ID>
    ORCHESTRATOR_FORGE_GITHUB_CLIENT_SECRET=<client secret>      # or ..._CLIENT_SECRET_FILE
    ORCHESTRATOR_FORGE_GITHUB_PRIVATE_KEY_FILE=/run/secrets/github-app.pem   # or ..._PRIVATE_KEY with the file's contents
    ORCHESTRATOR_FORGE_GITHUB_WEBHOOK_SECRET=<the webhook's secret>          # or ..._WEBHOOK_SECRET_FILE
    ```

    The first five are all set or none; a missing one stops the start and names it. The start also
    stops when the App ID is not a number, the URL name is not one (lowercase letters, digits and
    hyphens), the key is not a PEM private key, or the webhook secret is shorter than 16
    characters. The app is github.com's: `ORCHESTRATOR_FORGE_GITHUB_URL` takes `https://github.com`
    or a stand-in on this machine, and GitHub Enterprise Server is not offered.
12. Restart the orchestrator. An owner or an admin presses **Connect with GitHub** on the GitHub
    card, picks the account and the repositories on GitHub's install page, and comes back to the
    orchestrator. From then on it makes an hour's token from the app's key when it needs one.
