-- An orchestrator's Postgres database at schema 32 (floor {"version":4}), made by lab/fixture-dump.sh from refs/heads/orchestrator (6ece510c21353f98013bc9c5b2e3de981e32be04).
-- Filled through the orchestrator's API: an owner and a member (.example.invalid), the team repository team-skills, one task that ran to review. No session, no sealed value.
-- Rows per table:
--   api_keys: 0
--   command_receipts: 0
--   events: 5
--   forges: 0
--   group_tags: 0
--   identities: 0
--   identity_events: 0
--   identity_logins: 0
--   identity_sessions: 0
--   identity_sign_ins: 0
--   ingest_ids: 0
--   invites: 0
--   machine_pairings: 0
--   machines: 0
--   member_groups: 0
--   member_tags: 0
--   oidc_logins: 0
--   orgs: 0
--   policies: 0
--   project_locks: 0
--   repos: 1
--   request_numbers: 1
--   requests: 1
--   runner_nonces: 0
--   schema_floor: 1
--   schema_version: 1
--   secrets: 0
--   service_accounts: 0
--   sessions: 0
--   settings: 1
--   sso_domains: 0
--   task_attachments: 0
--   task_effects: 0
--   task_extra_spend: 0
--   task_followups: 0
--   task_log: 8
--   task_requests: 0
--   task_targets: 0
--   tasks: 1
--   team_owners: 1
--   usage_counts: 0
--   users: 2
--
-- PostgreSQL database dump
--

\restrict tblSVqf2jxZS2o5hhJY79zSmubHwa90WqhPK3Bsb0L7YTGL0LcCrvckCMt58dI0

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.14 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: console_events_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.console_events_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'the event log is append-only'; END IF;
  IF OLD.at > to_char((now() AT TIME ZONE 'UTC') - interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'an event younger than 30 days is kept';
  END IF;
  RETURN OLD;
END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    tenant text NOT NULL,
    id text NOT NULL,
    prefix text NOT NULL,
    secret_hash text NOT NULL,
    name text NOT NULL,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    scopes text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL,
    expires_at text,
    last_used_at text,
    revoked_at text,
    minted_by text
);


--
-- Name: command_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.command_receipts (
    tenant text NOT NULL,
    actor_id text NOT NULL,
    command_id text NOT NULL,
    kind text NOT NULL,
    task_id text NOT NULL,
    result text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    tenant text NOT NULL,
    id text NOT NULL,
    at text NOT NULL,
    kind text NOT NULL,
    actor_kind text NOT NULL,
    actor_id text,
    actor_email text,
    actor_name text,
    repo_id text,
    subject text,
    detail text NOT NULL
);


--
-- Name: forges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forges (
    tenant text NOT NULL,
    repo_id text NOT NULL,
    kind text NOT NULL,
    api_url text NOT NULL,
    project text NOT NULL
);


--
-- Name: group_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_tags (
    tenant text NOT NULL,
    grp text NOT NULL,
    tag text NOT NULL
);


--
-- Name: identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identities (
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    email_verified_at text NOT NULL,
    terms_url text,
    terms_accepted_at text,
    created_at text NOT NULL
);


--
-- Name: identity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_events (
    id text NOT NULL,
    identity_id text NOT NULL,
    at text NOT NULL,
    kind text NOT NULL,
    provider text NOT NULL,
    email_domain text NOT NULL,
    org text
);


--
-- Name: identity_logins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_logins (
    provider text NOT NULL,
    subject text NOT NULL,
    identity_id text NOT NULL,
    email text NOT NULL,
    added_at text NOT NULL
);


--
-- Name: identity_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_sessions (
    token_hash text NOT NULL,
    identity_id text NOT NULL,
    csrf text NOT NULL,
    method text NOT NULL,
    domain text,
    authenticated_at text NOT NULL,
    expires_at text NOT NULL,
    id text,
    created_at text,
    last_seen_at text,
    user_agent text
);


--
-- Name: identity_sign_ins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_sign_ins (
    state text NOT NULL,
    provider text NOT NULL,
    purpose text NOT NULL,
    nonce text NOT NULL,
    verifier text NOT NULL,
    identity_id text,
    invite_id text,
    expires_at text NOT NULL,
    account text
);


--
-- Name: ingest_ids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_ids (
    id text NOT NULL,
    tenant text NOT NULL,
    repo_id text NOT NULL
);


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    tenant text NOT NULL,
    id text NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    teams text NOT NULL,
    token_hash text NOT NULL,
    invited_by text NOT NULL,
    created_at text NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: machine_pairings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine_pairings (
    tenant text NOT NULL,
    code_hash text NOT NULL,
    user_id text NOT NULL,
    expires_at text NOT NULL,
    used_at text
);


--
-- Name: machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machines (
    tenant text NOT NULL,
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    public_key text NOT NULL,
    token_hash text NOT NULL,
    agents text NOT NULL,
    created_at text NOT NULL,
    last_seen_at text,
    revoked_at text
);


--
-- Name: member_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_groups (
    tenant text NOT NULL,
    user_id text NOT NULL,
    grp text NOT NULL
);


--
-- Name: member_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_tags (
    tenant text NOT NULL,
    user_id text NOT NULL,
    tag text NOT NULL
);


--
-- Name: oidc_logins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_logins (
    state text NOT NULL,
    tenant text NOT NULL,
    nonce text NOT NULL,
    verifier text NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    tenant text NOT NULL,
    name text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL,
    quotas text NOT NULL,
    deleted_at text,
    plan text DEFAULT 'free'::text NOT NULL
);


--
-- Name: policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policies (
    tenant text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    audience text NOT NULL,
    rules text NOT NULL,
    updated_at text NOT NULL,
    updated_by text NOT NULL
);


--
-- Name: project_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_locks (
    tenant text NOT NULL,
    project_id text NOT NULL,
    task_id text NOT NULL,
    taken_at text NOT NULL
);


--
-- Name: repos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repos (
    tenant text NOT NULL,
    id text NOT NULL,
    team text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    head text,
    synced_at text,
    error text
);


--
-- Name: request_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_numbers (
    tenant text NOT NULL,
    repo_id text NOT NULL,
    last integer NOT NULL
);


--
-- Name: requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requests (
    tenant text NOT NULL,
    repo_id text NOT NULL,
    number integer NOT NULL,
    provider text NOT NULL,
    url text NOT NULL,
    branch text NOT NULL,
    head_sha text NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    created_by text NOT NULL,
    merged_at text,
    checked_head text,
    held_head text,
    held_reason text
);


--
-- Name: runner_nonces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_nonces (
    tenant text NOT NULL,
    machine_id text NOT NULL,
    nonce text NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: schema_floor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_floor (
    version integer NOT NULL
);


--
-- Name: schema_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_version (
    version integer NOT NULL
);


--
-- Name: secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secrets (
    tenant text NOT NULL,
    name text NOT NULL,
    sealed text NOT NULL,
    updated_at text NOT NULL,
    updated_by text NOT NULL
);


--
-- Name: service_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_accounts (
    tenant text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    token_hash text NOT NULL,
    tenant text NOT NULL,
    user_id text NOT NULL,
    csrf text NOT NULL,
    expires_at text NOT NULL,
    id text,
    created_at text,
    last_seen_at text,
    user_agent text
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    tenant text NOT NULL,
    key text NOT NULL,
    value text NOT NULL
);


--
-- Name: sso_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sso_domains (
    tenant text NOT NULL,
    domain text NOT NULL,
    token text NOT NULL,
    added_by text NOT NULL,
    added_at text NOT NULL,
    verified_at text
);


--
-- Name: task_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_attachments (
    tenant text NOT NULL,
    id text NOT NULL,
    task_id text NOT NULL,
    name text NOT NULL,
    mime text NOT NULL,
    size integer NOT NULL,
    sha256 text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: task_effects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_effects (
    tenant text NOT NULL,
    id text NOT NULL,
    task_id text NOT NULL,
    seq integer NOT NULL,
    kind text NOT NULL,
    payload text NOT NULL,
    replay text NOT NULL,
    status text NOT NULL,
    attempts integer NOT NULL,
    claimed_by text,
    lease_until text,
    due_at text NOT NULL,
    last_error text,
    result text,
    created_at text NOT NULL,
    settled_at text
);


--
-- Name: task_extra_spend; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_extra_spend (
    tenant text NOT NULL,
    id text NOT NULL,
    created_by text NOT NULL,
    repo_id text NOT NULL,
    team text NOT NULL,
    at text NOT NULL,
    kind text NOT NULL,
    usd double precision,
    input_tokens integer,
    output_tokens integer
);


--
-- Name: task_followups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_followups (
    tenant text NOT NULL,
    id text NOT NULL,
    task_id text NOT NULL,
    source text NOT NULL,
    key text NOT NULL,
    text text NOT NULL,
    quotes text,
    status text NOT NULL,
    created_at text NOT NULL,
    delivered_at text,
    created_by text NOT NULL
);


--
-- Name: task_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_log (
    tenant text NOT NULL,
    task_id text NOT NULL,
    seq integer NOT NULL,
    at text NOT NULL,
    text text NOT NULL,
    kind text DEFAULT 'log'::text NOT NULL,
    data text,
    source_n integer
);


--
-- Name: task_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_requests (
    tenant text NOT NULL,
    id text NOT NULL,
    task_id text NOT NULL,
    target_position integer,
    source_key text NOT NULL,
    kind text NOT NULL,
    payload text NOT NULL,
    status text NOT NULL,
    response_capability text NOT NULL,
    answer text,
    answered_by text,
    answered_via text,
    created_at text NOT NULL,
    answered_at text,
    expires_at text
);


--
-- Name: task_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_targets (
    tenant text NOT NULL,
    task_id text NOT NULL,
    "position" integer NOT NULL,
    repo_id text NOT NULL,
    status text NOT NULL,
    reason text NOT NULL,
    base_sha text,
    branch text,
    tests text,
    request_number integer,
    error text,
    cost_usd double precision,
    input_tokens integer,
    output_tokens integer
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    tenant text NOT NULL,
    id text NOT NULL,
    repo_id text NOT NULL,
    team text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    issue_url text,
    issue_key text,
    agent text NOT NULL,
    status text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL,
    started_at text,
    finished_at text,
    base_sha text,
    tests text,
    cost_usd double precision,
    input_tokens integer,
    output_tokens integer,
    request_number integer,
    error text,
    log_seq integer DEFAULT 0 NOT NULL,
    pgid integer,
    branch text,
    template text,
    target_mode text,
    stage text,
    skills text,
    mode text,
    parent_id text,
    depth integer DEFAULT 0 NOT NULL,
    runner text DEFAULT 'server'::text NOT NULL,
    claimed_by text,
    lease_id text,
    lease_until text,
    native_session text,
    choices text,
    stop_requested_at text,
    result text,
    changes text,
    tools text
);


--
-- Name: team_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_owners (
    tenant text NOT NULL,
    user_id text NOT NULL,
    team text NOT NULL
);


--
-- Name: usage_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_counts (
    tenant text NOT NULL,
    repo_id text NOT NULL,
    skill text NOT NULL,
    hour text NOT NULL,
    count integer NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    tenant text NOT NULL,
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    password_hash text,
    oidc_issuer text,
    oidc_subject text,
    forge_login text,
    created_at text NOT NULL,
    identity_id text,
    sessions_revoked_at text
);


--
-- Data for Name: api_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.api_keys (tenant, id, prefix, secret_hash, name, owner_kind, owner_id, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, minted_by) FROM stdin;
\.


--
-- Data for Name: command_receipts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.command_receipts (tenant, actor_id, command_id, kind, task_id, result, created_at) FROM stdin;
\.


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.events (tenant, id, at, kind, actor_kind, actor_id, actor_email, actor_name, repo_id, subject, detail) FROM stdin;
fixture	evt_01m6hgjg3x84c5ycp5508y24yf	2026-11-03T20:10:54.973Z	orchestrator.setup	user	usr_01m6hgjg255rcj07kvppa702db	owner@fixture.example.invalid	Fixture Owner	\N	account:usr_01m6hgjg255rcj07kvppa702db	created the first owner with the setup code
fixture	evt_01m6hgjg6f8bmmps1gvccz1q0t	2026-11-03T20:10:55.055Z	account.created	user	usr_01m6hgjg255rcj07kvppa702db	owner@fixture.example.invalid	Fixture Owner	\N	account:usr_01m6hgjg4pjymrehyz4phqqb90	member@fixture.example.invalid as member of Core, signing in with password
fixture	evt_01m6hgjn10daee3z29q6th86ar	2026-11-03T20:11:00.000Z	task.started	user	usr_01m6hgjg255rcj07kvppa702db	owner@fixture.example.invalid	Fixture Owner	team-skills	task:tsk_01m6hgjn0xacet9aj5ea4xzetf	Add a fixture skill on team-skills
fixture	evt_01m6hgk6k5r6s938f4qjh9bc8z	2026-11-03T20:11:17.989Z	request.opened	user	usr_01m6hgjg255rcj07kvppa702db	owner@fixture.example.invalid	Fixture Owner	team-skills	request:1	"Add a fixture skill" on task/tsk_01m6hgjn0xacet9aj5ea4xzetf, changing skills/add-a-fixture-skill/SKILL.md
fixture	evt_01m6hgke6nq08fj60n37dy540f	2026-11-03T20:11:25.781Z	task.succeeded	orchestrator	\N	\N	TeamHandbook Orchestrator	team-skills	task:tsk_01m6hgjn0xacet9aj5ea4xzetf	"Add a fixture skill" is waiting for review
\.


--
-- Data for Name: forges; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.forges (tenant, repo_id, kind, api_url, project) FROM stdin;
\.


--
-- Data for Name: group_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.group_tags (tenant, grp, tag) FROM stdin;
\.


--
-- Data for Name: identities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identities (id, email, name, email_verified_at, terms_url, terms_accepted_at, created_at) FROM stdin;
\.


--
-- Data for Name: identity_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identity_events (id, identity_id, at, kind, provider, email_domain, org) FROM stdin;
\.


--
-- Data for Name: identity_logins; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identity_logins (provider, subject, identity_id, email, added_at) FROM stdin;
\.


--
-- Data for Name: identity_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identity_sessions (token_hash, identity_id, csrf, method, domain, authenticated_at, expires_at, id, created_at, last_seen_at, user_agent) FROM stdin;
\.


--
-- Data for Name: identity_sign_ins; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identity_sign_ins (state, provider, purpose, nonce, verifier, identity_id, invite_id, expires_at, account) FROM stdin;
\.


--
-- Data for Name: ingest_ids; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ingest_ids (id, tenant, repo_id) FROM stdin;
\.


--
-- Data for Name: invites; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.invites (tenant, id, email, role, teams, token_hash, invited_by, created_at, expires_at) FROM stdin;
\.


--
-- Data for Name: machine_pairings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.machine_pairings (tenant, code_hash, user_id, expires_at, used_at) FROM stdin;
\.


--
-- Data for Name: machines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.machines (tenant, id, user_id, name, platform, public_key, token_hash, agents, created_at, last_seen_at, revoked_at) FROM stdin;
\.


--
-- Data for Name: member_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.member_groups (tenant, user_id, grp) FROM stdin;
\.


--
-- Data for Name: member_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.member_tags (tenant, user_id, tag) FROM stdin;
\.


--
-- Data for Name: oidc_logins; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.oidc_logins (state, tenant, nonce, verifier, expires_at) FROM stdin;
\.


--
-- Data for Name: orgs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.orgs (tenant, name, created_by, created_at, quotas, deleted_at, plan) FROM stdin;
\.


--
-- Data for Name: policies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.policies (tenant, id, name, audience, rules, updated_at, updated_by) FROM stdin;
\.


--
-- Data for Name: project_locks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_locks (tenant, project_id, task_id, taken_at) FROM stdin;
\.


--
-- Data for Name: repos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.repos (tenant, id, team, name, url, head, synced_at, error) FROM stdin;
fixture	team-skills	Core	team-skills	file:///srv/fixture/repos/team-skills.git	90c9c177146bf9130425df6e96b634bcea36baf6	2026-11-03T20:11:25.733Z	\N
\.


--
-- Data for Name: request_numbers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.request_numbers (tenant, repo_id, last) FROM stdin;
fixture	team-skills	1
\.


--
-- Data for Name: requests; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.requests (tenant, repo_id, number, provider, url, branch, head_sha, title, status, created_at, created_by, merged_at, checked_head, held_head, held_reason) FROM stdin;
fixture	team-skills	1	local	local://requests/team-skills/1	task/tsk_01m6hgjn0xacet9aj5ea4xzetf	839bde2f3eadf56b21abcd2f28196527f653bdce	Add a fixture skill	open	2026-11-03T20:11:17.984Z	owner@fixture.example.invalid	\N	839bde2f3eadf56b21abcd2f28196527f653bdce	\N	\N
\.


--
-- Data for Name: runner_nonces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.runner_nonces (tenant, machine_id, nonce, expires_at) FROM stdin;
\.


--
-- Data for Name: schema_floor; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_floor (version) FROM stdin;
4
\.


--
-- Data for Name: schema_version; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_version (version) FROM stdin;
32
\.


--
-- Data for Name: secrets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.secrets (tenant, name, sealed, updated_at, updated_by) FROM stdin;
\.


--
-- Data for Name: service_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.service_accounts (tenant, id, name, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (token_hash, tenant, user_id, csrf, expires_at, id, created_at, last_seen_at, user_agent) FROM stdin;
\.


--
-- Data for Name: settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.settings (tenant, key, value) FROM stdin;
fixture	setup.claimed	usr_01m6hgjg255rcj07kvppa702db
\.


--
-- Data for Name: sso_domains; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sso_domains (tenant, domain, token, added_by, added_at, verified_at) FROM stdin;
\.


--
-- Data for Name: task_attachments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_attachments (tenant, id, task_id, name, mime, size, sha256, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: task_effects; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_effects (tenant, id, task_id, seq, kind, payload, replay, status, attempts, claimed_by, lease_until, due_at, last_error, result, created_at, settled_at) FROM stdin;
\.


--
-- Data for Name: task_extra_spend; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_extra_spend (tenant, id, created_by, repo_id, team, at, kind, usd, input_tokens, output_tokens) FROM stdin;
\.


--
-- Data for Name: task_followups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_followups (tenant, id, task_id, source, key, text, quotes, status, created_at, delivered_at, created_by) FROM stdin;
\.


--
-- Data for Name: task_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_log (tenant, task_id, seq, at, text, kind, data, source_n) FROM stdin;
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	1	2026-11-03T20:11:03.627Z	Checked out team-skills at 90c9c17.	log	\N	\N
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	2	2026-11-03T20:11:04.132Z	Installed 1 team skill(s) and 0 MCP server(s) for Demo agent.	log	\N	\N
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	3	2026-11-03T20:11:04.163Z	Starting Demo agent.	log	\N	\N
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	4	2026-11-03T20:11:04.536Z	reading the task: Add a fixture skill	log	\N	\N
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	5	2026-11-03T20:11:04.543Z	wrote skills/add-a-fixture-skill/SKILL.md	log	\N	\N
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	6	2026-11-03T20:11:04.550Z	No test command is set for team-skills; tests were skipped.	log	\N	\N
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	7	2026-11-03T20:11:05.007Z	The agent changed 1 file(s): skills/add-a-fixture-skill/SKILL.md	log	\N	\N
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	8	2026-11-03T20:11:25.740Z	Opened request #1 on task/tsk_01m6hgjn0xacet9aj5ea4xzetf. It waits for a person to review and merge it.	log	\N	\N
\.


--
-- Data for Name: task_requests; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_requests (tenant, id, task_id, target_position, source_key, kind, payload, status, response_capability, answer, answered_by, answered_via, created_at, answered_at, expires_at) FROM stdin;
\.


--
-- Data for Name: task_targets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_targets (tenant, task_id, "position", repo_id, status, reason, base_sha, branch, tests, request_number, error, cost_usd, input_tokens, output_tokens) FROM stdin;
\.


--
-- Data for Name: tasks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tasks (tenant, id, repo_id, team, title, description, issue_url, issue_key, agent, status, created_by, created_at, started_at, finished_at, base_sha, tests, cost_usd, input_tokens, output_tokens, request_number, error, log_seq, pgid, branch, template, target_mode, stage, skills, mode, parent_id, depth, runner, claimed_by, lease_id, lease_until, native_session, choices, stop_requested_at, result, changes, tools) FROM stdin;
fixture	tsk_01m6hgjn0xacet9aj5ea4xzetf	team-skills	Core	Add a fixture skill	Add a skill named after this task.	\N	\N	fake	needs-review	owner@fixture.example.invalid	2026-11-03T20:10:59.997Z	2026-11-03T20:11:00.000Z	2026-11-03T20:11:25.778Z	90c9c177146bf9130425df6e96b634bcea36baf6	skipped	\N	\N	\N	1	\N	8	\N	task/tsk_01m6hgjn0xacet9aj5ea4xzetf	\N	\N	request	\N	auto	\N	0	server	\N	\N	\N	\N	\N	\N	\N	\N	\N
\.


--
-- Data for Name: team_owners; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.team_owners (tenant, user_id, team) FROM stdin;
fixture	usr_01m6hgjg4pjymrehyz4phqqb90	Core
\.


--
-- Data for Name: usage_counts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usage_counts (tenant, repo_id, skill, hour, count) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (tenant, id, email, name, role, password_hash, oidc_issuer, oidc_subject, forge_login, created_at, identity_id, sessions_revoked_at) FROM stdin;
fixture	usr_01m6hgjg255rcj07kvppa702db	owner@fixture.example.invalid	Fixture Owner	owner	scrypt$32768$8$1$neuFkR6Ghbvg2Z1N/2LydA==$zAftFW/Ung7Jirz+jiGhyFEX3FCsokOORUm2nDkBGjo=	\N	\N	\N	2026-11-03T20:10:54.966Z	\N	\N
fixture	usr_01m6hgjg4pjymrehyz4phqqb90	member@fixture.example.invalid	Fixture Member	member	scrypt$32768$8$1$ioPRz9BSQAQ1F/cnrMbtxQ==$75OkyiyvQ1a3+aj2MgrjZZHvLyIg2Yn6ECbpdgVUhPs=	\N	\N	\N	2026-11-03T20:10:55.046Z	\N	\N
\.


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (tenant, id);


--
-- Name: command_receipts command_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.command_receipts
    ADD CONSTRAINT command_receipts_pkey PRIMARY KEY (tenant, actor_id, command_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (tenant, id);


--
-- Name: forges forges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forges
    ADD CONSTRAINT forges_pkey PRIMARY KEY (tenant, repo_id);


--
-- Name: group_tags group_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_tags
    ADD CONSTRAINT group_tags_pkey PRIMARY KEY (tenant, grp);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identity_events identity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_events
    ADD CONSTRAINT identity_events_pkey PRIMARY KEY (id);


--
-- Name: identity_logins identity_logins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_logins
    ADD CONSTRAINT identity_logins_pkey PRIMARY KEY (provider, subject);


--
-- Name: identity_sessions identity_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_sessions
    ADD CONSTRAINT identity_sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: identity_sign_ins identity_sign_ins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_sign_ins
    ADD CONSTRAINT identity_sign_ins_pkey PRIMARY KEY (state);


--
-- Name: ingest_ids ingest_ids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_ids
    ADD CONSTRAINT ingest_ids_pkey PRIMARY KEY (id);


--
-- Name: ingest_ids ingest_ids_tenant_repo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_ids
    ADD CONSTRAINT ingest_ids_tenant_repo_id_key UNIQUE (tenant, repo_id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (tenant, id);


--
-- Name: machine_pairings machine_pairings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_pairings
    ADD CONSTRAINT machine_pairings_pkey PRIMARY KEY (tenant, code_hash);


--
-- Name: machines machines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_pkey PRIMARY KEY (tenant, id);


--
-- Name: member_groups member_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_groups
    ADD CONSTRAINT member_groups_pkey PRIMARY KEY (tenant, user_id, grp);


--
-- Name: member_tags member_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_tags
    ADD CONSTRAINT member_tags_pkey PRIMARY KEY (tenant, user_id, tag);


--
-- Name: oidc_logins oidc_logins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_logins
    ADD CONSTRAINT oidc_logins_pkey PRIMARY KEY (state);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (tenant);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (tenant, id);


--
-- Name: project_locks project_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_locks
    ADD CONSTRAINT project_locks_pkey PRIMARY KEY (tenant, project_id);


--
-- Name: repos repos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repos
    ADD CONSTRAINT repos_pkey PRIMARY KEY (tenant, id);


--
-- Name: request_numbers request_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_numbers
    ADD CONSTRAINT request_numbers_pkey PRIMARY KEY (tenant, repo_id);


--
-- Name: requests requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (tenant, repo_id, number);


--
-- Name: runner_nonces runner_nonces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_nonces
    ADD CONSTRAINT runner_nonces_pkey PRIMARY KEY (tenant, machine_id, nonce);


--
-- Name: secrets secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (tenant, name);


--
-- Name: service_accounts service_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_accounts
    ADD CONSTRAINT service_accounts_pkey PRIMARY KEY (tenant, id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (tenant, key);


--
-- Name: sso_domains sso_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_domains
    ADD CONSTRAINT sso_domains_pkey PRIMARY KEY (tenant, domain);


--
-- Name: task_attachments task_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_pkey PRIMARY KEY (tenant, id);


--
-- Name: task_effects task_effects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_pkey PRIMARY KEY (tenant, id);


--
-- Name: task_extra_spend task_extra_spend_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_extra_spend
    ADD CONSTRAINT task_extra_spend_pkey PRIMARY KEY (tenant, id);


--
-- Name: task_followups task_followups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_followups
    ADD CONSTRAINT task_followups_pkey PRIMARY KEY (tenant, id);


--
-- Name: task_log task_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_log
    ADD CONSTRAINT task_log_pkey PRIMARY KEY (tenant, task_id, seq);


--
-- Name: task_requests task_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_requests
    ADD CONSTRAINT task_requests_pkey PRIMARY KEY (tenant, id);


--
-- Name: task_targets task_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_targets
    ADD CONSTRAINT task_targets_pkey PRIMARY KEY (tenant, task_id, "position");


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (tenant, id);


--
-- Name: team_owners team_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_owners
    ADD CONSTRAINT team_owners_pkey PRIMARY KEY (tenant, user_id, team);


--
-- Name: usage_counts usage_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_counts
    ADD CONSTRAINT usage_counts_pkey PRIMARY KEY (tenant, repo_id, skill, hour);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (tenant, id);


--
-- Name: api_keys_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_owner ON public.api_keys USING btree (tenant, owner_kind, owner_id);


--
-- Name: api_keys_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX api_keys_prefix ON public.api_keys USING btree (prefix);


--
-- Name: events_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_at ON public.events USING btree (tenant, at, id);


--
-- Name: events_first; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_first ON public.events USING btree (tenant, kind, at, id);


--
-- Name: identities_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX identities_email ON public.identities USING btree (email);


--
-- Name: identity_events_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_events_at ON public.identity_events USING btree (at, id);


--
-- Name: identity_logins_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_logins_identity ON public.identity_logins USING btree (identity_id);


--
-- Name: identity_sessions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX identity_sessions_id ON public.identity_sessions USING btree (id);


--
-- Name: invites_address; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invites_address ON public.invites USING btree (email);


--
-- Name: invites_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invites_email ON public.invites USING btree (tenant, email);


--
-- Name: invites_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invites_token ON public.invites USING btree (token_hash);


--
-- Name: machines_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX machines_token ON public.machines USING btree (token_hash);


--
-- Name: machines_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machines_user ON public.machines USING btree (tenant, user_id);


--
-- Name: orgs_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orgs_created_by ON public.orgs USING btree (created_by, created_at);


--
-- Name: runner_nonces_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runner_nonces_expiry ON public.runner_nonces USING btree (expires_at);


--
-- Name: sessions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sessions_id ON public.sessions USING btree (id);


--
-- Name: settings_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settings_key ON public.settings USING btree (key);


--
-- Name: task_attachments_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_attachments_task ON public.task_attachments USING btree (tenant, task_id);


--
-- Name: task_effects_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_effects_due ON public.task_effects USING btree (status, due_at);


--
-- Name: task_effects_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_effects_order ON public.task_effects USING btree (tenant, task_id, seq);


--
-- Name: task_extra_spend_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_extra_spend_at ON public.task_extra_spend USING btree (tenant, at);


--
-- Name: task_followups_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_followups_key ON public.task_followups USING btree (tenant, task_id, key);


--
-- Name: task_log_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_log_source ON public.task_log USING btree (tenant, task_id, source_n);


--
-- Name: task_requests_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_requests_pending ON public.task_requests USING btree (status, expires_at);


--
-- Name: task_requests_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_requests_source ON public.task_requests USING btree (tenant, task_id, source_key);


--
-- Name: task_targets_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_targets_request ON public.task_targets USING btree (tenant, repo_id, request_number);


--
-- Name: tasks_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_claim ON public.tasks USING btree (tenant, status, runner, created_by, created_at);


--
-- Name: tasks_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_creator ON public.tasks USING btree (tenant, created_by, created_at);


--
-- Name: tasks_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_lease ON public.tasks USING btree (status, lease_until);


--
-- Name: tasks_newest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_newest ON public.tasks USING btree (tenant, created_at, id);


--
-- Name: tasks_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_parent ON public.tasks USING btree (tenant, parent_id);


--
-- Name: tasks_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_request ON public.tasks USING btree (tenant, repo_id, request_number);


--
-- Name: users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email ON public.users USING btree (tenant, email);


--
-- Name: users_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_identity ON public.users USING btree (tenant, identity_id);


--
-- Name: users_oidc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_oidc ON public.users USING btree (tenant, oidc_issuer, oidc_subject);


--
-- Name: events events_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER events_guard BEFORE DELETE OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.console_events_guard();


--
-- PostgreSQL database dump complete
--

\unrestrict tblSVqf2jxZS2o5hhJY79zSmubHwa90WqhPK3Bsb0L7YTGL0LcCrvckCMt58dI0

