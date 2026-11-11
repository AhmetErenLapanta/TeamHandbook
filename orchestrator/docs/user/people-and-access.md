# People and access

## Sign-in and roles

### Signing up to a cloud orchestrator

On a cloud orchestrator (`ORCHESTRATOR_MODE=cloud`) people sign up themselves at `/signup`, with Google,
GitHub or Microsoft, each a button once the operator sets it up (`ORCHESTRATOR_SIGN_IN_*`). The
orchestrator keeps a person by the provider's own id, never by the address, and takes an address only
when the provider vouches for it: Google's `email_verified`, Microsoft's `xms_edov`, with
personal Microsoft accounts refused, and GitHub's verified primary address. Signing in makes
nobody a member of anything: a person reaches the organizations they own or were invited to,
and nobody joins one without an invitation: someone who signs in uninvited belongs to no
organization until they create one. An invitation is accepted by signing in from its link with
a provider whose verified address is the invited one; another address, or an address the
provider did not verify, is refused and told why. Otherwise they create one at
`/signup/organization`: a name, an address (2 to 39 lower-case letters, digits and dashes, not a
path the orchestrator answers itself, and never given again once its organization is deleted), and
the terms of use accepted. The organization, its first owner and its name are made in one step
or not at all, under the daily limit. They become its owner, the acceptance is kept with the address of the
terms and the time, and the welcome opens (see [The screens](screens.md#the-screens)). One person creates
at most `ORCHESTRATOR_ORGS_PER_IDENTITY_DAY` organizations a day. Until `ORCHESTRATOR_PRIVACY_URL` and
`ORCHESTRATOR_TERMS_URL` name the operator's pages, signup is closed. An organization nobody created
answers 404. A cloud orchestrator prints no setup code and takes no password; what follows about the
setup code and passwords is for a self-hosted orchestrator. A release from `orchestrator/deploy/` takes
these settings from its env file (see [Run it as a service](../operations/run-as-a-service.md#run-it-as-a-service)).

An orchestrator without an owner prints a setup code to its log at every start, or takes
`ORCHESTRATOR_SETUP_TOKEN`. Whoever enters the code creates the first owner, once. Until then
nobody signs in, through SSO either. If an orchestrator ends up with accounts but no owner, restart
it: the setup code is printed again for as long as no owner exists, and setup creates one
beside the accounts already there.

Everything about people is under **Settings**:

- **Members.** Invite people by pasting their addresses, separated by spaces, with the role and
  teams they join with. Each invitation is a one-time link, valid for seven days, shown once to
  whoever invited; the orchestrator sends no mail. Resend gives a new link and a new week, Revoke
  ends it. With single sign-on, signing in with the invited, verified address accepts it too.
  Each member has a page with their role, teams, tags, and the requests and tasks they started.
- **Service accounts.** Non-human members for CI and automations. A service account owns the
  teams you pick, so its keys open requests and start tasks there.
- **API keys.** Personal keys, and keys of a service account. A key looks like
  `th_sk_<12 hex digits>_<secret>`, is shown once, and is kept only as its prefix and a hash.
  Give each resource none, read or write access (repositories, requests, tasks; read only for
  usage, members and settings), and an expiry of a day to a year, or none. Send it as
  `Authorization: Bearer th_sk_...`. A key acts as its account with that account's role today;
  it never manages members, roles, settings or sign-in, and never merges a request. A key with
  "This account's API keys" mints keys for its own account, none wider and none longer-lived.
- **Task secrets.** Values a task's agent needs, such as a registry token, for every
  repository of a team or for one repository, written once and never shown again; the orchestrator
  keeps their names, when they changed and by whom. They need `ORCHESTRATOR_SECRET_KEY`.
- **Security.** Single sign-on and directory sync (below).
- **Your account.** Change your name, and delete your account: a summary first says, for each
  organization this browser is signed in to, your role and teams, the API keys revoked, and the
  requests and running tasks that stay with their teams; you type your address to confirm, and
  the account goes from each. The only owner of an organization cannot delete theirs.
- **Privacy.** Who sees the usage leaderboard, how many days task logs are kept (30 by
  default; the task and its request stay), how many days skill-use counts are kept (365 by
  default, at least 90 so Usage and its export never lose a day they show; older counts are
  deleted, not summed), and which teams report skill use. Reporting starts
  and stops only by a request merged into the team's repository, from the repository's page.

| Role | Reads | Proposes and merges changes, starts tasks | Manages members, service accounts, forge access, settings | Changes owners, directory sync |
|---|---|---|---|---|
| Owner | every team | every team | yes | yes |
| Admin | every team | every team | yes | no |
| Member | every team | the teams they own | no | no |

A task and its log are read by whoever can start tasks on its team, by the person who started
it, and by a member it was shared with; to anyone else the task does not exist. Whoever started a
task or edits its team presses **Share…** on its page and enters a teammate's email: another
active member of the organization, never anyone outside it, who gets reading alone, while
stopping, keeping, undoing and answering stay with the team's rules. The person it was shared with
passes it on to nobody. **Remove…** under **Shared with** stops a share, for whoever made it, an
editor of the team or an admin, and each share and its end go to the organization's log.

Owning a team is apart from the role: any member can own teams. Nobody grants a role above
their own or changes their own role, and the last owner can be neither demoted nor removed. An
owner cannot leave the organization; another owner changes their role first. A database from
before roles and team ownership were parted opens with every admin as an owner and every team
owner as a member who keeps their teams.

Single sign-on works with any OpenID Connect provider (`ORCHESTRATOR_OIDC_*`); register
`<ORCHESTRATOR_PUBLIC_URL>/api/auth/oidc/callback` with it. A person is known by the provider's
issuer and subject, not by an address. At a first SSO sign-in:

- an address with an unexpired invitation joins with the invited role and teams, when the
  provider says it verified the address (a token without `email_verified: true` counts as
  unverified);
- an address an owner or admin added without a password through the API is bound to that
  person, once, the same way;
- an address nobody has becomes a member, and an owner or admin raises the role;
- an address that belongs to an account with a password, or one already bound, is refused.

An account that signs in through SSO does not set a password of its own; an owner or admin
sets one when it needs one, and the orchestrator logs that it happened.

**Directory sync.** Each SSO sign-in records the groups the ID token lists in
`ORCHESTRATOR_OIDC_GROUPS_CLAIM` (`groups` by default). Under Settings, Security, give a group a tag
and press Preview: it lists who gains and who loses which tag, and nothing changes until an
owner presses Apply, which is refused if a member's groups changed since the preview. Members
of a mapped group have its tag and lose it when a later sign-in no longer lists the group;
tags added by hand on a member's page stay. Tags are the audiences team policies name. A group
nobody mapped gives no tag.

**SSO domains.** Under Settings, Security, an owner adds an email domain and publishes the TXT
record shown (`_teamhandbook-orchestrator.<domain>`), then presses Verify. While single sign-on is set
up, everyone at a verified domain but owners signs in through it: their passwords stop opening
their accounts, their open sessions end at verification, and an invitation to an address there
is accepted through SSO. Owners keep their password, so a provider outage locks nobody out.
Their personal API keys and the tokens of apps they approved stop working at verification, and
they make no new personal key; give automation there a service account. A verified domain
covers its subdomains: verifying `acme.example` covers `eu.acme.example` too. Once a domain is
verified, the provider lets in without an invitation only addresses at a verified domain or
under it. Removing the domain turns this off.

**Directory provisioning (SCIM 2.0).** Under Settings, Security, an owner makes a SCIM token and
gives it, with the base URL shown there (`<ORCHESTRATOR_PUBLIC_URL>/api/scim/v2`, or
`/api/orgs/<org>/scim/v2` for an organization after the first), to Okta, Entra ID or another
provider. It provisions `Users` (userName, name, emails, active, externalId) and `Groups`
(displayName, members), filtered by `userName`, `externalId` or `displayName` `eq`. People it
adds are members; it turns them off and on and removes them, and its group names feed directory
sync. Someone turned off loses every way in at once. While the token is set, single sign-on
adds nobody the directory did not.

**SAML** is not offered. Checking a SAML response safely needs XML signature verification,
whose known failures (signature wrapping, canonicalization differences) are what a vetted
library guards against, and the orchestrator carries none. Providers that speak SAML also speak
OpenID Connect; connect that.
