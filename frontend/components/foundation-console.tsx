"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, BarChart3, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardList, Command, FileKey2, LayoutDashboard, LoaderCircle, LogOut, Menu, MoreHorizontal, Plus, Search, Settings2, ShieldCheck, Sparkles, Users, UsersRound, X, Ticket } from "lucide-react";
import { api, ApiError, clearApi, configureApi } from "@/lib/api";
import { hasFoundationWorkspacePermission, hasSupportWorkspacePermission, landingView, visibleWorkspaceNavigation } from "@/lib/role-navigation";
import { useAuth } from "@/components/auth-provider";
import type { CurrentUser, Department, Organisation, RoleCapability, Team, TeamMembership, UserDetail, UserListItem, UserStatus } from "@/types/foundation";
import { SupportWorkspace } from "@/components/support-workspace";
import { AuditWorkspace, ConfigurationWorkspace, ReportsWorkspace, SupportDashboard } from "@/components/operational-pages";

type View = "overview" | "users" | "organisations" | "teams" | "dashboard" | "tickets" | "reports" | "audit" | "configuration";
const roleLabels: Record<string, string> = { organisation_admin: "Organisation admin", support_lead: "Support lead", support_agent: "Support agent", requester: "Requester" };
const statusTone: Record<string, string> = { active: "status-active", inactive: "status-muted", suspended: "status-danger" };
const orgSchema = z.object({ name: z.string().trim().min(1, "Enter an organisation name.") });
const inviteSchema = z.object({ email: z.email("Enter a valid email address."), displayName: z.string().trim().min(1, "Enter a display name."), roles: z.array(z.string()).min(1, "Choose at least one role.") });
const departmentSchema = z.object({ name: z.string().trim().min(1, "Enter a department name.") });
const teamSchema = z.object({ name: z.string().trim().min(1, "Enter a team name."), departmentId: z.string() });
const organisationEditSchema = z.object({ name: z.string().trim().min(1), status: z.enum(["active", "inactive", "suspended"]), settings: z.string().refine(value => { try { return !!JSON.parse(value) && typeof JSON.parse(value) === "object" && !Array.isArray(JSON.parse(value)); } catch { return false; } }, "Settings must be a valid JSON object.") });
type Toast = { tone: "success" | "error" | "info"; message: string; requestId?: string };

export function FoundationConsole() {
  const { status: authStatus, accessToken, login, logout } = useAuth();
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [organisations, setOrganisations] = useState<Organisation[]>([]);
  const [selectedOrg, setSelectedOrg] = useState("");
  const [activeView, setActiveView] = useState<View>("overview");
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [roles, setRoles] = useState<RoleCapability[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [userDrawer, setUserDrawer] = useState<UserDetail | null>(null);
  const [teamDrawer, setTeamDrawer] = useState<Team | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMembership[]>([]);
  const [dialog, setDialog] = useState<"organisation" | "invite" | "department" | "team" | null>(null);
  const [authError, setAuthError] = useState("");

  const activeContext = currentUser?.organisations.find(item => item.organisationId === selectedOrg);
  const permissionSet = useMemo(() => new Set(activeContext?.permissions ?? []), [activeContext]);
  const can = useCallback((permission: string) => permissionSet.has(permission), [permissionSet]);
  const activeOrganisation = organisations.find(item => item.id === selectedOrg);
  const hasSupportWorkspace = activeContext ? hasSupportWorkspacePermission(activeContext.permissions) : false;
  const hasFoundationWorkspace = activeContext ? hasFoundationWorkspacePermission(activeContext.permissions) : false;

  const notify = useCallback((message: string, tone: Toast["tone"] = "success", requestId?: string) => {
    setToast({ message, tone, requestId });
    window.setTimeout(() => setToast(current => current?.message === message ? null : current), 5200);
  }, []);
  const showError = useCallback((error: unknown) => error instanceof ApiError
    ? notify(`${error.message}${error.fields?.length ? ` ${error.fields.map(field => `${field.field}: ${field.message}`).join(" · ")}` : ""}`, "error", error.requestId)
    : notify(error instanceof Error ? error.message : "Something went wrong. Try again.", "error"), [notify]);

  const setCredentials = useCallback((accessToken: string, organisationId: string) => {
    configureApi(accessToken, organisationId);
  }, []);

  const loadFoundation = useCallback(async (accessToken: string, organisationId: string) => {
    setCredentials(accessToken, "");
    setLoading(true);
    try {
      const [orgResult, userResult] = await Promise.all([api.organisations(), api.me()]);
      const activeMemberships = new Set(userResult.data.organisations.map(item => item.organisationId));
      const availableOrganisations = orgResult.data.filter(org => activeMemberships.has(org.id));
      const nextOrgId = availableOrganisations.some(org => org.id === organisationId)
        ? organisationId : availableOrganisations[0]?.id ?? "";
      if (!nextOrgId) throw new ApiError(403, "NO_ACTIVE_ORGANISATION", "This account has no active organisation membership.");
      setOrganisations(availableOrganisations);
      setCurrentUser(userResult.data);
      setSelectedOrg(nextOrgId);
      setCredentials(accessToken, nextOrgId);
      if (nextOrgId) sessionStorage.setItem("foundation.org", nextOrgId);
      const available = userResult.data.organisations.find(item => item.organisationId === nextOrgId);
      if (available) setActiveView(landingView(available.permissions));
      if (available?.permissions.includes("users.manage")) {
        try { setRoles((await api.roles()).data); } catch { setRoles([]); }
      } else setRoles([]);
      setConnected(true);
    } catch (error) {
      setConnected(false);
      clearApi();
      throw error;
    } finally { setLoading(false); }
  }, [setCredentials]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !accessToken) {
      if (authStatus === "anonymous") {
        clearApi(); setConnected(false); setToken(""); setCurrentUser(null);
        setOrganisations([]); setSelectedOrg(""); setUsers([]); setTeams([]); setDepartments([]);
      }
      return;
    }
    setToken(accessToken);
    const savedOrg = sessionStorage.getItem("foundation.org") ?? "";
    void loadFoundation(accessToken, savedOrg).then(() => setAuthError("")).catch(error => {
      setAuthError(error instanceof ApiError && error.code === "NO_ACTIVE_ORGANISATION"
        ? "Your account signed in successfully, but it has no active organisation membership yet. Ask an organisation administrator to grant access."
        : error instanceof ApiError
          ? `${error.message}${error.requestId ? ` (Request ID: ${error.requestId})` : ""}`
          : "The account could not be connected to the support workspace.");
    });
  }, [authStatus, accessToken, loadFoundation]);

  const refreshCurrent = useCallback(async () => {
    if (!token || !selectedOrg) return;
    setCredentials(token, selectedOrg);
    try {
      const [orgResult, userResult] = await Promise.all([api.organisations(), api.me()]);
      setOrganisations(orgResult.data);
      setCurrentUser(userResult.data);
      if (!orgResult.data.some(item => item.id === selectedOrg)) setSelectedOrg(orgResult.data[0]?.id ?? "");
    } catch (error) { showError(error); }
  }, [token, selectedOrg, setCredentials, showError]);

  const loadViewData = useCallback(async () => {
    if (!connected || !selectedOrg) return;
    setCredentials(token, selectedOrg);
    const operations: Promise<unknown>[] = [];
    if (can("users.read")) operations.push(api.users().then(result => setUsers(result.data)));
    if (can("teams.read")) {
      operations.push(api.departments().then(result => setDepartments(result.data)));
      operations.push(api.teams().then(result => setTeams(result.data)));
    }
    if (can("users.manage")) operations.push(api.roles().then(result => setRoles(result.data)).catch(() => setRoles([])));
    const results = await Promise.allSettled(operations);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) showError(rejected.reason);
  }, [connected, selectedOrg, token, can, setCredentials, showError]);

  useEffect(() => { void loadViewData(); }, [loadViewData]);

  const startSignIn = async () => {
    setConnecting(true);
    setAuthError("");
    try { await login(); }
    catch { setAuthError("Keycloak sign-in could not be started. Check that the identity provider is running and configured."); }
    finally { setConnecting(false); }
  };

  const disconnect = () => {
    sessionStorage.removeItem("foundation.org");
    setConnected(false); setToken(""); setCurrentUser(null); setOrganisations([]); setSelectedOrg(""); setUsers([]); clearApi();
    void logout().catch(() => setAuthError("Keycloak sign-out could not be completed. Close this tab to end the local session."));
  };

  const changeOrganisation = async (id: string) => {
    setSelectedOrg(id);
    sessionStorage.setItem("foundation.org", id);
    if (token) setCredentials(token, id);
    const context = currentUser?.organisations.find(item => item.organisationId === id);
    if (context) setActiveView(landingView(context.permissions));
    setUserDrawer(null); setTeamDrawer(null);
  };

  const openUser = async (id: string) => {
    setCredentials(token, selectedOrg);
    try { setUserDrawer((await api.user(id)).data); } catch (error) { showError(error); }
  };
  const openTeam = async (team: Team) => {
    setCredentials(token, selectedOrg);
    try { setTeamDrawer(team); setTeamMembers((await api.teamMembers(team.id)).data); } catch (error) { showError(error); }
  };

  const createOrganisationForm = useForm<z.infer<typeof orgSchema>>({ resolver: zodResolver(orgSchema), defaultValues: { name: "" } });
  const inviteForm = useForm<z.infer<typeof inviteSchema>>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", displayName: "", roles: ["support_agent"] } });
  const departmentForm = useForm<z.infer<typeof departmentSchema>>({ resolver: zodResolver(departmentSchema), defaultValues: { name: "" } });
  const teamForm = useForm<z.infer<typeof teamSchema>>({ resolver: zodResolver(teamSchema), defaultValues: { name: "", departmentId: "" } });

  const createOrganisation = createOrganisationForm.handleSubmit(async values => {
    setCredentials(token, selectedOrg);
    try {
      const created = await api.createOrganisation(values.name);
      setDialog(null); createOrganisationForm.reset(); notify("Organisation created; administrator membership granted.");
      await refreshCurrent(); await changeOrganisation(created.data.id);
    } catch (error) { showError(error); }
  });
  const inviteUser = inviteForm.handleSubmit(async values => {
    setCredentials(token, selectedOrg);
    try { await api.inviteUser(values); setDialog(null); inviteForm.reset({ email: "", displayName: "", roles: ["support_agent"] }); notify("Invitation created."); await loadViewData(); }
    catch (error) { showError(error); }
  });
  const createDepartment = departmentForm.handleSubmit(async values => {
    setCredentials(token, selectedOrg);
    try { await api.createDepartment(values.name); setDialog(null); departmentForm.reset(); notify("Department created."); await loadViewData(); }
    catch (error) { showError(error); }
  });
  const createTeam = teamForm.handleSubmit(async values => {
    setCredentials(token, selectedOrg);
    try { await api.createTeam(values.name, values.departmentId || null); setDialog(null); teamForm.reset(); notify("Team created."); await loadViewData(); }
    catch (error) { showError(error); }
  });

  const filteredUsers = useMemo(() => users.filter(user => `${user.displayName} ${user.email} ${user.id} ${user.roles.join(" ")}`.toLowerCase().includes(search.toLowerCase())), [users, search]);
  const filteredOrganisations = useMemo(() => organisations.filter(org => `${org.name} ${org.id} ${org.status}`.toLowerCase().includes(search.toLowerCase())), [organisations, search]);
  const filteredTeams = useMemo(() => teams.filter(team => `${team.name} ${team.id} ${departments.find(dept => dept.id === team.departmentId)?.name ?? ""}`.toLowerCase().includes(search.toLowerCase())), [teams, departments, search]);

  if (!connected) return <ConnectScreen status={authStatus} connecting={connecting} authError={authError} onSignIn={startSignIn} onSignOut={disconnect} />;

  const viewTitle: Record<View, string> = { overview: "Overview", users: "Users & access", organisations: "Organisations", teams: "Teams & departments", dashboard: "Support dashboard", tickets: "Support tickets", reports: "Reports", audit: "Ticket audit", configuration: "Configuration" };
  const navItems = [
    { id: "dashboard" as const, label: "Dashboard", icon: LayoutDashboard, permission: "tickets.read.assigned" },
    { id: "tickets" as const, label: "Ticket queue", icon: Ticket, permission: "tickets.read.assigned" },
    { id: "reports" as const, label: "Reports", icon: BarChart3, permission: "reports.read.team" },
    { id: "audit" as const, label: "Ticket audit", icon: ClipboardList, permission: "tickets.audit.read" },
    { id: "configuration" as const, label: "Configuration", icon: Settings2, permission: "configuration.manage" },
    { id: "overview" as const, label: "Overview", icon: LayoutDashboard, permission: "organisation.read" },
    { id: "users" as const, label: "Users", icon: UsersRound, permission: "users.read" },
    { id: "organisations" as const, label: "Organisations", icon: Building2, permission: "organisation.read" },
    { id: "teams" as const, label: "Teams & departments", icon: Users, permission: "teams.read" },
  ];
  const visibleViews = new Set(visibleWorkspaceNavigation(activeContext?.permissions ?? [], hasSupportWorkspace, hasFoundationWorkspace));
  const nav = navItems.filter(item => visibleViews.has(item.id));
  const isOperationalView = ["dashboard", "tickets", "reports", "audit", "configuration"].includes(activeView);

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Command size={18} strokeWidth={2.5} /></div><div><strong>Support HQ</strong><span>{hasFoundationWorkspace ? "ADMIN WORKSPACE" : "SUPPORT WORKSPACE"}</span></div><button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="workspace-switch"><div className="workspace-avatar">{(activeOrganisation?.name ?? "S").slice(0, 1).toUpperCase()}</div><div className="workspace-copy"><span>WORKSPACE</span><strong>{activeOrganisation?.name ?? "Select organisation"}</strong></div><ChevronDown size={16} className="muted-icon" /></div>
      <div className="nav-caption">{hasFoundationWorkspace && hasSupportWorkspace ? "WORKSPACES" : hasFoundationWorkspace ? "ADMINISTRATION" : "SUPPORT"}</div>
      <nav className="side-nav" aria-label="Main navigation">{nav.map(item => <button key={item.id} className={`nav-item ${activeView === item.id ? "nav-active" : ""}`} onClick={() => { setActiveView(item.id); setSearch(""); setMobileOpen(false); }}><item.icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.id === "users" && <span className="nav-count">{users.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><CircleHelp size={17} /></div><strong>Need a hand?</strong><span>Manage access and workspace settings from one place.</span></div><div className="profile-mini"><div className="profile-avatar">{(currentUser?.user.displayName ?? "U").slice(0, 1).toUpperCase()}</div><div className="profile-copy"><strong>{currentUser?.user.displayName}</strong><span>{activeContext?.roles.map(role => roleLabels[role] ?? role).join(" · ")}</span></div><button className="icon-button" aria-label="Sign out" onClick={disconnect}><LogOut size={16} /></button></div></div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={19} /></button><div className="breadcrumb"><span>{["dashboard","tickets","reports","audit"].includes(activeView) ? "Support" : activeView === "configuration" ? "Administration" : "Foundation"}</span><ChevronRight size={14} /><strong>{viewTitle[activeView]}</strong></div></div><div className="topbar-right"><span className="secure-label"><ShieldCheck size={15} /> {activeContext?.roles.map(role => roleLabels[role] ?? role).join(" · ")}</span><div className="topbar-divider" /><label className="org-select-wrap"><span className="sr-only">Active organisation</span><Building2 size={15} /><select value={selectedOrg} onChange={event => void changeOrganisation(event.target.value)} aria-label="Active organisation">{organisations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select><ChevronDown size={14} className="select-chevron" /></label><button className="profile-avatar top-avatar" aria-label={`Signed in as ${currentUser?.user.displayName}`}>{(currentUser?.user.displayName ?? "U").slice(0, 1).toUpperCase()}</button></div></header>
      <div className="page-content">
        {!isOperationalView && <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> IDENTITY & ORGANISATION</div><h1>{viewTitle[activeView]}</h1><p>{activeView === "overview" ? "A clear view of people and access across your workspace." : activeView === "users" ? "Manage organisation members, roles and access." : activeView === "organisations" ? "View the workspaces available to your account." : "Organise support teams and their department associations."}</p></div><div className="heading-actions">{activeView === "organisations" && can("organisations.create") && <button className="button button-primary" onClick={() => setDialog("organisation")}><Plus size={16} /> New organisation</button>}{activeView === "users" && can("users.manage") && <button className="button button-primary" onClick={() => setDialog("invite")}><Plus size={16} /> Invite user</button>}{activeView === "teams" && can("teams.manage") && <><button className="button button-secondary" onClick={() => setDialog("department")}><Plus size={16} /> Department</button><button className="button button-primary" onClick={() => setDialog("team")}><Plus size={16} /> Create team</button></>}</div></div>}
        {!isOperationalView && activeView !== "overview" && <div className="toolbar"><div className="search-box"><Search size={16} /><input placeholder={`Search ${activeView === "users" ? "users" : activeView === "teams" ? "teams and departments" : "organisations"}`} value={search} onChange={event => setSearch(event.target.value)} /><kbd>⌘ K</kbd></div><div className="toolbar-meta">{activeView === "users" ? `${filteredUsers.length} members` : activeView === "organisations" ? `${filteredOrganisations.length} organisations` : `${filteredTeams.length} teams`}<button className="icon-button subtle" aria-label="Refresh" onClick={() => void loadViewData()}><Activity size={16} /></button></div></div>}
        {loading && <div className="loading-line"><LoaderCircle size={16} className="spin" /> Loading workspace…</div>}
        {activeView === "overview" && <Overview currentUser={currentUser} organisation={activeOrganisation} users={users} teams={teams} departments={departments} onNavigate={setActiveView} can={can} />}
        {activeView === "users" && <UsersPage users={filteredUsers} roles={roles} can={can} onOpen={openUser} onInvite={() => setDialog("invite")} />}
        {activeView === "organisations" && <OrganisationsPage organisations={filteredOrganisations} activeId={selectedOrg} can={can} token={token} onSelect={changeOrganisation} onUpdated={refreshCurrent} onToast={notify} />}
        {activeView === "teams" && <TeamsPage teams={filteredTeams} departments={departments} can={can} onOpen={openTeam} onCreateTeam={() => setDialog("team")} onCreateDepartment={() => setDialog("department")} />}
        {activeView === "dashboard" && <SupportDashboard teams={teams} canReports={can("reports.read.team") || can("reports.read.all")} onError={showError} />}
        {activeView === "tickets" && <SupportWorkspace canCreate={can("tickets.create.own")} canComment={can("tickets.create.own") || can("tickets.read.assigned") || can("tickets.read.team") || can("tickets.read.all")} canAi={can("tickets.ai.review")} canResolution={can("tickets.resolution.review")} canAudit={can("tickets.audit.read")} isLead={activeContext?.roles.includes("support_lead") ?? false} canApprove={can("tickets.approve")} canEscalate={can("tickets.read.assigned") || can("tickets.read.team") || can("tickets.read.all")} canResolveEscalation={can("tickets.approve")} reviewerId={currentUser?.user.id ?? ""} requesterDisplayName={currentUser?.user.displayName} requesterEmail={currentUser?.user.email} teams={teams.map(team => ({ id: team.id, name: team.name }))} canRoute={can("tickets.routing.manage")} canPrioritize={can("tickets.priority.manage")} onError={showError} onSuccess={notify} />}
        {activeView === "reports" && <ReportsWorkspace canReports={can("reports.read.team") || can("reports.read.all")} onError={showError} />}
        {activeView === "audit" && <AuditWorkspace canAudit={can("tickets.audit.read")} canAi={can("tickets.ai.review")} canReadOrganisationAudit={activeContext?.roles.includes("organisation_admin") ?? false} onError={showError} />}
        {activeView === "configuration" && <ConfigurationWorkspace teams={teams} canReadPolicies={can("policies.read")} canConfigure={can("configuration.manage")} canAdmin={activeContext?.roles.includes("organisation_admin") ?? false} onError={showError} onOpenTeams={() => setActiveView("teams")} />}
        <footer className="page-footer"><span><ShieldCheck size={14} /> Access is enforced by your organisation’s backend permissions.</span><span>{isOperationalView ? "Support workspace · API v1" : "Foundation · API v1"}</span></footer>
      </div>
    </main>
    {toast && <div className={`toast toast-${toast.tone}`} role="status"><span className="toast-indicator">{toast.tone === "success" ? <Check size={15} /> : <X size={15} />}</span><div><strong>{toast.message}</strong>{toast.requestId && <span>Request ID · {toast.requestId}</span>}</div><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {dialog === "organisation" && <Modal title="Create organisation" subtitle="Your account will receive administrator access to the new organisation." onClose={() => setDialog(null)}><form onSubmit={createOrganisation} className="form-stack"><Field label="Organisation name" error={createOrganisationForm.formState.errors.name?.message}><input {...createOrganisationForm.register("name")} placeholder="e.g. Customer Operations" autoFocus /></Field><FormFooter busy={createOrganisationForm.formState.isSubmitting} onCancel={() => setDialog(null)} submit="Create organisation" /></form></Modal>}
    {dialog === "invite" && <Modal title="Invite a user" subtitle="Create an account and add it to this organisation." onClose={() => setDialog(null)}><form onSubmit={inviteUser} className="form-stack"><Field label="Work email" error={inviteForm.formState.errors.email?.message}><input type="email" {...inviteForm.register("email")} placeholder="name@company.com" autoFocus /></Field><Field label="Display name" error={inviteForm.formState.errors.displayName?.message}><input {...inviteForm.register("displayName")} placeholder="Full name" /></Field><fieldset className="role-fieldset"><legend>Organisation roles</legend><div className="role-options">{roles.map(role => <label className="role-option" key={role.id}><input type="checkbox" value={role.id} {...inviteForm.register("roles")} /><span><strong>{roleLabels[role.id] ?? role.id}</strong><small>{role.description}</small></span></label>)}</div>{inviteForm.formState.errors.roles?.message && <small className="field-error">{inviteForm.formState.errors.roles.message}</small>}</fieldset><FormFooter busy={inviteForm.formState.isSubmitting} onCancel={() => setDialog(null)} submit="Send invitation" /></form></Modal>}
    {dialog === "department" && <Modal title="Create department" subtitle="Departments help group teams within this organisation." onClose={() => setDialog(null)}><form onSubmit={createDepartment} className="form-stack"><Field label="Department name" error={departmentForm.formState.errors.name?.message}><input {...departmentForm.register("name")} placeholder="e.g. Customer Support" autoFocus /></Field><FormFooter busy={departmentForm.formState.isSubmitting} onCancel={() => setDialog(null)} submit="Create department" /></form></Modal>}
    {dialog === "team" && <Modal title="Create team" subtitle="Create a tenant-scoped support team." onClose={() => setDialog(null)}><form onSubmit={createTeam} className="form-stack"><Field label="Team name" error={teamForm.formState.errors.name?.message}><input {...teamForm.register("name")} placeholder="e.g. Tier 1 Support" autoFocus /></Field><Field label="Department" hint="Optional"><select {...teamForm.register("departmentId")}><option value="">No department</option>{departments.map(dept => <option value={dept.id} key={dept.id}>{dept.name}</option>)}</select></Field><FormFooter busy={teamForm.formState.isSubmitting} onCancel={() => setDialog(null)} submit="Create team" /></form></Modal>}
    {userDrawer && <UserDrawer user={userDrawer} roles={roles} token={token} organisationId={selectedOrg} can={can} onClose={() => setUserDrawer(null)} onToast={notify} onUpdated={async () => { await loadViewData(); await openUser(userDrawer.id); }} />}
    {teamDrawer && <TeamDrawer team={teamDrawer} members={teamMembers} users={users} departments={departments} can={can} token={token} organisationId={selectedOrg} onClose={() => setTeamDrawer(null)} onToast={notify} onChanged={async () => { await loadViewData(); await openTeam(teamDrawer); }} />}
  </div>;
}

function ConnectScreen({ status, connecting, authError, onSignIn, onSignOut }: { status: "initializing" | "authenticated" | "anonymous" | "configuration_error" | "provider_error"; connecting: boolean; authError: string; onSignIn: () => void; onSignOut: () => void }) {
  const message = status === "configuration_error"
    ? "Keycloak sign-in is not configured. Set the public Keycloak URL, realm, and client ID in frontend/.env.local, then restart the frontend."
    : status === "provider_error"
      ? "The Keycloak sign-in service could not be reached. Check the realm URL and try again."
      : authError;
  return <main className="connect-screen"><div className="connect-brand"><div className="brand-mark"><Command size={18} strokeWidth={2.5} /></div><strong>Support HQ</strong><span>FOUNDATION</span></div><section className="connect-card"><div className="connect-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-icon"><Building2 size={28} /></div><div className="art-chip chip-a"><UsersRound size={16} /></div><div className="art-chip chip-b"><ShieldCheck size={16} /></div><div className="art-glow" /></div><div className="connect-copy"><div className="eyebrow"><span className="eyebrow-dot" /> FOUNDATION CONSOLE</div><h1>People and access,<br /><em>in one clear place.</em></h1><p>Sign in with your organisation account to access the workspace and the tools allowed by your role.</p>{status === "initializing" ? <div className="connect-loading"><LoaderCircle size={17} className="spin" /> Checking your sign-in session�</div> : <div className="form-stack connect-form">{message && <div className="connect-error" role="alert"><X size={15} /><span>{message}</span></div>}{status === "authenticated" && authError && <button type="button" className="button button-secondary connect-submit" onClick={onSignOut}>Sign out and switch account</button>}{status !== "configuration_error" && <button type="button" className="button button-primary connect-submit" disabled={connecting || status === "authenticated"} onClick={onSignIn}>{connecting ? <><LoaderCircle size={16} className="spin" /> Opening sign-in�</> : status === "authenticated" ? <>Checking workspace access� <LoaderCircle size={15} className="spin" /></> : <>Sign in with Keycloak <ChevronRight size={16} /></>}</button>}</div>}<div className="connect-note"><ShieldCheck size={15} /><span>Your organisation membership and permissions are checked by the support API after sign-in.</span></div></div></section><div className="connect-footer">SUPPORT PLATFORM <span>�</span> IDENTITY & ACCESS</div></main>;
}

function Overview({ currentUser, organisation, users, teams, departments, onNavigate, can }: { currentUser: CurrentUser | null; organisation?: Organisation; users: UserListItem[]; teams: Team[]; departments: Department[]; onNavigate: (view: View) => void; can: (permission: string) => boolean }) {
  return <div className="overview-layout"><section className="welcome-panel"><div className="welcome-copy"><div className="eyebrow light"><Sparkles size={14} /> WORKSPACE SNAPSHOT</div><h2>Good to have you here,<br /><span>{currentUser?.user.displayName?.split(" ")[0]}.</span></h2><p>Manage who can access <strong>{organisation?.name}</strong> and how your support teams are organised.</p><button className="button button-white" onClick={() => onNavigate("users")}>Manage people <ChevronRight size={16} /></button></div><div className="welcome-art"><div className="welcome-ring ring-a" /><div className="welcome-ring ring-b" /><div className="welcome-core"><Building2 size={30} /></div><span className="floating-avatar avatar-one">{(currentUser?.user.displayName ?? "U").slice(0, 1)}</span><span className="floating-avatar avatar-two"><Users size={15} /></span><span className="floating-avatar avatar-three"><ShieldCheck size={15} /></span></div><div className="welcome-foot"><span><span className="live-dot" /> WORKSPACE ACTIVE</span><span>{organisation?.status ?? "—"}</span></div></section><div className="overview-main"><div className="section-title-row"><div><span className="eyebrow">AT A GLANCE</span><h2>Workspace overview</h2></div><span className="live-status"><span className="live-dot" /> Live data</span></div><div className="metric-grid"><Metric icon={UsersRound} label="Active members" value={can("users.read") ? users.length : null} hint="In this organisation" tone="blue" /><Metric icon={Users} label="Support teams" value={can("teams.read") ? teams.length : null} hint="Across departments" tone="violet" /><Metric icon={Building2} label="Departments" value={can("teams.read") ? departments.length : null} hint="Organisation groups" tone="amber" /></div><div className="overview-lower"><section className="surface-card members-card"><div className="card-heading"><div><h3>People & access</h3><p>Organisation members and assigned roles</p></div><button className="text-action" onClick={() => onNavigate("users")}>View members <ChevronRight size={15} /></button></div>{users.length ? <div className="mini-list">{users.slice(0, 4).map(user => <button className="mini-person" key={user.id} onClick={() => onNavigate("users")}><span className="person-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span className="person-meta"><strong>{user.displayName}</strong><small>{user.email}</small></span><span className="role-pill">{roleLabels[user.roles[0] ?? ""] ?? user.roles[0] ?? "Member"}</span></button>)}</div> : <EmptyState title="No members to show" description={can("users.read") ? "No active users are assigned to this organisation yet." : "Your role does not include the users list."} />}</section><section className="surface-card org-card"><div className="card-heading"><div><h3>Current organisation</h3><p>Your active workspace context</p></div><button className="icon-button subtle" onClick={() => onNavigate("organisations")} aria-label="Open organisation settings"><Settings2 size={17} /></button></div><div className="org-summary"><div className="org-summary-icon"><Building2 size={20} /></div><div><strong>{organisation?.name ?? "No organisation selected"}</strong><span>{organisation?.id ?? ""}</span></div><StatusBadge status={organisation?.status ?? "unknown"} /></div><div className="org-summary-footer"><span>Access roles</span><div className="role-list">{currentUser?.organisations.find(item => item.organisationId === organisation?.id)?.roles.map(role => <span className="role-tag" key={role}>{roleLabels[role] ?? role}</span>)}</div></div><button className="org-settings-link" onClick={() => onNavigate("organisations")}>Organisation details <ArrowUp size={14} /></button></section></div></div></div>;
}

function Metric({ icon: Icon, label, value, hint, tone }: { icon: typeof Users; label: string; value: number | null; hint: string; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon metric-${tone}`}><Icon size={18} /></div><span className="metric-label">{label}</span><strong className="metric-value">{value ?? "—"}</strong><span className="metric-hint">{hint}</span></div>;
}

function UsersPage({ users, roles, can, onOpen, onInvite }: { users: UserListItem[]; roles: RoleCapability[]; can: (permission: string) => boolean; onOpen: (id: string) => void; onInvite: () => void }) {
  const columns = useMemo<ColumnDef<UserListItem>[]>(() => [
    { accessorKey: "displayName", header: "Member", cell: ({ row }) => <button className="table-person" onClick={() => onOpen(row.original.id)}><span className="person-avatar">{row.original.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{row.original.displayName}</strong><small>{row.original.email}</small></span></button> },
    { accessorKey: "roles", header: "Organisation role", cell: ({ row }) => <div className="role-list">{row.original.roles.map(role => <span className="role-tag" key={role}>{roleLabels[role] ?? role}</span>)}</div> },
    { accessorKey: "status", header: "Account status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { id: "permissions", header: "Access", cell: ({ row }) => <span className="permission-count"><ShieldCheck size={14} /> {row.original.permissions.length} permissions</span> },
    { id: "action", header: "", cell: ({ row }) => <button className="icon-button subtle" aria-label={`View ${row.original.displayName}`} onClick={() => onOpen(row.original.id)}><MoreHorizontal size={17} /></button> },
  ], [onOpen]);
  return <section className="surface-card table-card"><div className="table-intro"><div><h2>Members</h2><p>People with an active membership in this organisation.</p></div><div className="table-intro-right"><span className="count-chip"><UsersRound size={14} /> {users.length} active</span>{can("users.manage") && <button className="button button-primary button-small" onClick={onInvite}><Plus size={15} /> Invite user</button>}</div></div><DataTable columns={columns} data={users} emptyTitle="No active members" emptyText={can("users.manage") && roles.length ? "Invite a colleague to give them access to this organisation." : "No active user memberships were returned by the backend."} /></section>;
}

function OrganisationsPage({ organisations, activeId, can, token, onSelect, onUpdated, onToast }: { organisations: Organisation[]; activeId: string; can: (permission: string) => boolean; token: string; onSelect: (id: string) => Promise<void>; onUpdated: () => Promise<void>; onToast: (message: string, tone?: Toast["tone"], requestId?: string) => void }) {
  const [editing, setEditing] = useState<Organisation | null>(null);
  const columns = useMemo<ColumnDef<Organisation>[]>(() => [
    { accessorKey: "name", header: "Organisation", cell: ({ row }) => <button className="org-name-cell" onClick={() => void onSelect(row.original.id)}><span className="org-table-icon"><Building2 size={17} /></span><span><strong>{row.original.name}</strong><small>{row.original.id}</small></span></button> },
    { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { accessorKey: "updatedAt", header: "Last updated", cell: ({ row }) => <span className="date-cell">{new Date(row.original.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span> },
    { id: "active", header: "Context", cell: ({ row }) => row.original.id === activeId ? <span className="active-context"><Check size={13} /> Current</span> : <button className="text-action" onClick={() => void onSelect(row.original.id)}>Switch to <ChevronRight size={14} /></button> },
    { id: "edit", header: "", cell: ({ row }) => can("organisation.update") && row.original.id === activeId && <button className="icon-button subtle" aria-label={`Edit ${row.original.name}`} onClick={() => setEditing(row.original)}><Settings2 size={16} /></button> },
  ], [activeId, can, onSelect]);
  return <><section className="surface-card table-card"><div className="table-intro"><div><h2>Your organisations</h2><p>Only active organisations where your account has membership are listed.</p></div><span className="count-chip"><Building2 size={14} /> {organisations.length} available</span></div><DataTable columns={columns} data={organisations} emptyTitle="No active organisations" emptyText="This account has no active organisation memberships." /></section>{editing && <OrganisationEditor organisation={editing} token={token} activeId={activeId} onClose={() => setEditing(null)} onUpdated={async () => { setEditing(null); onToast("Organisation updated."); await onUpdated(); }} onToast={onToast} />}</>;
}

function OrganisationEditor({ organisation, token, activeId, onClose, onUpdated, onToast }: { organisation: Organisation; token: string; activeId: string; onClose: () => void; onUpdated: () => Promise<void>; onToast: (message: string, tone?: Toast["tone"], requestId?: string) => void }) {
  const form = useForm<z.infer<typeof organisationEditSchema>>({ resolver: zodResolver(organisationEditSchema), defaultValues: { name: organisation.name, status: organisation.status, settings: JSON.stringify(organisation.settings, null, 2) } });
  const submit = form.handleSubmit(async value => {
    if (value.status !== "active" && organisation.id === activeId && !window.confirm("Changing this organisation’s status may remove access to this workspace. Continue?")) return;
    configureApi(token, activeId);
    try { await api.updateOrganisation(organisation.id, { name: value.name, status: value.status, settings: JSON.parse(value.settings) }); await onUpdated(); }
    catch (error) { const e = error instanceof ApiError ? error : null; onToast(e?.message ?? "Organisation could not be updated.", "error", e?.requestId); }
  });
  return <Modal title="Organisation settings" subtitle="Changes are validated and saved by the backend." onClose={onClose}><form className="form-stack" onSubmit={submit}><Field label="Organisation name" error={form.formState.errors.name?.message}><input {...form.register("name")} /></Field><Field label="Status" hint="Status changes can affect members’ ability to access the organisation."><select {...form.register("status")}><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select></Field><Field label="Settings JSON" error={form.formState.errors.settings?.message}><textarea className="code-input" rows={6} {...form.register("settings")} /></Field><FormFooter busy={form.formState.isSubmitting} onCancel={onClose} submit="Save changes" /></form></Modal>;
}

function TeamsPage({ teams, departments, can, onOpen, onCreateTeam, onCreateDepartment }: { teams: Team[]; departments: Department[]; can: (permission: string) => boolean; onOpen: (team: Team) => void; onCreateTeam: () => void; onCreateDepartment: () => void }) {
  const columns = useMemo<ColumnDef<Team>[]>(() => [
    { accessorKey: "name", header: "Team", cell: ({ row }) => <button className="org-name-cell" onClick={() => onOpen(row.original)}><span className="team-table-icon"><UsersRound size={17} /></span><span><strong>{row.original.name}</strong><small>{row.original.id}</small></span></button> },
    { id: "department", header: "Department", cell: ({ row }) => <span className="date-cell">{departments.find(item => item.id === row.original.departmentId)?.name ?? "Unassigned"}</span> },
    { accessorKey: "updatedAt", header: "Last updated", cell: ({ row }) => <span className="date-cell">{new Date(row.original.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span> },
    { id: "action", header: "", cell: ({ row }) => <button className="text-action" onClick={() => onOpen(row.original)}>Manage <ChevronRight size={14} /></button> },
  ], [departments, onOpen]);
  return <div className="teams-layout"><section className="surface-card table-card"><div className="table-intro"><div><h2>Support teams</h2><p>Team membership is managed separately from organisation roles.</p></div>{can("teams.manage") && <button className="button button-primary button-small" onClick={onCreateTeam}><Plus size={15} /> Create team</button>}</div><DataTable columns={columns} data={teams} emptyTitle="No teams yet" emptyText={can("teams.manage") ? "Create a team to organise support work." : "No teams were returned for this organisation."} /></section><aside className="surface-card department-card"><div className="card-heading"><div><span className="eyebrow">STRUCTURE</span><h3>Departments</h3><p>{departments.length} in this organisation</p></div>{can("teams.manage") && <button className="icon-button add-icon" onClick={onCreateDepartment} aria-label="Create department"><Plus size={17} /></button>}</div>{departments.length ? <div className="department-list">{departments.map((dept, index) => <div className="department-row" key={dept.id}><span className={`department-dot dept-dot-${index % 4}`}><Building2 size={15} /></span><span><strong>{dept.name}</strong><small>{teams.filter(team => team.departmentId === dept.id).length} teams</small></span><ChevronRight size={15} /></div>)}</div> : <EmptyState title="No departments" description="Departments are optional groupings for support teams." compact />}</aside></div>;
}

function UserDrawer({ user, roles, token, organisationId, can, onClose, onToast, onUpdated }: { user: UserDetail; roles: RoleCapability[]; token: string; organisationId: string; can: (permission: string) => boolean; onClose: () => void; onToast: (message: string, tone?: Toast["tone"], requestId?: string) => void; onUpdated: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState<UserStatus>(user.status);
  const [selectedRoles, setSelectedRoles] = useState(user.roles);
  const [saving, setSaving] = useState(false);
  const canManage = can("users.manage");
  const save = async () => {
    setSaving(true); configureApi(token, organisationId);
    try {
      if (displayName !== user.displayName) await api.updateUser(user.id, displayName.trim());
      if (status !== "active" || selectedRoles.join("|") !== user.roles.join("|")) await api.updateMembership(user.id, { status, roles: selectedRoles });
      onToast("User access updated."); await onUpdated();
    } catch (error) { const e = error instanceof ApiError ? error : null; onToast(e?.message ?? "User could not be updated.", "error", e?.requestId); }
    finally { setSaving(false); }
  };
  const toggleRole = (role: string) => setSelectedRoles(current => current.includes(role) ? current.filter(item => item !== role) : [...current, role]);
  return <div className="drawer-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="User details"><div className="drawer-head"><div><span className="eyebrow">USER DETAILS</span><h2>Member profile</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div><div className="drawer-person"><span className="drawer-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div><h3>{user.displayName}</h3><p>{user.email}</p></div><StatusBadge status={status} /></div><div className="drawer-section"><div className="detail-label">Account ID</div><code className="id-code">{user.id}</code></div><div className="drawer-section"><div className="detail-label">Profile</div><Field label="Display name"><input value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={!canManage} /></Field><Field label="Account status" hint="The account lifecycle is managed by identity provisioning."><input value={user.status} disabled /></Field></div><div className="drawer-section"><div className="drawer-section-heading"><div><div className="detail-label">Organisation membership</div><p>Roles determine backend permissions.</p></div></div><Field label="Membership status"><select value={status} onChange={event => setStatus(event.target.value as UserStatus)} disabled={!canManage}><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select></Field><div className="drawer-role-options">{roles.map(role => <label key={role.id} className={`drawer-role ${selectedRoles.includes(role.id) ? "drawer-role-selected" : ""}`}><input type="checkbox" checked={selectedRoles.includes(role.id)} onChange={() => toggleRole(role.id)} disabled={!canManage} /><span><strong>{roleLabels[role.id] ?? role.id}</strong><small>{role.description}</small></span>{selectedRoles.includes(role.id) && <Check size={15} />}</label>)}</div>{!canManage && <p className="permission-note"><ShieldCheck size={14} /> Your role allows viewing, but not changing memberships.</p>}</div><div className="drawer-section"><div className="detail-label">Effective permissions</div><div className="permission-tags">{user.permissions.map(permission => <span key={permission}>{permission}</span>)}</div></div><div className="drawer-footer"><button className="button button-secondary" onClick={onClose}>Close</button>{canManage && <button className="button button-primary" disabled={saving || !selectedRoles.length} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save access</button>}</div></aside></div>;
}

function TeamDrawer({ team, members, users, departments, can, token, organisationId, onClose, onToast, onChanged }: { team: Team; members: TeamMembership[]; users: UserListItem[]; departments: Department[]; can: (permission: string) => boolean; token: string; organisationId: string; onClose: () => void; onToast: (message: string, tone?: Toast["tone"], requestId?: string) => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(team.name);
  const [departmentId, setDepartmentId] = useState(team.departmentId ?? "");
  const [assignUser, setAssignUser] = useState("");
  const [memberRole, setMemberRole] = useState<TeamMembership["role"]>("support_agent");
  const [saving, setSaving] = useState(false);
  const eligibleUsers = users.filter(user => !members.some(member => member.userId === user.id && member.status === "active"));
  const canManage = can("teams.manage");
  const saveTeam = async () => {
    setSaving(true); configureApi(token, organisationId);
    try { await api.updateTeam(team.id, { name: name.trim(), departmentId: departmentId || null }); onToast("Team updated."); await onChanged(); }
    catch (error) { const e = error instanceof ApiError ? error : null; onToast(e?.message ?? "Team could not be updated.", "error", e?.requestId); }
    finally { setSaving(false); }
  };
  const addMember = async () => {
    if (!assignUser) return;
    setSaving(true); configureApi(token, organisationId);
    try { await api.setTeamMember(team.id, { userId: assignUser, role: memberRole, status: "active" }); setAssignUser(""); onToast("Team member added."); await onChanged(); }
    catch (error) { const e = error instanceof ApiError ? error : null; onToast(e?.message ?? "Team member could not be added.", "error", e?.requestId); }
    finally { setSaving(false); }
  };
  const setMemberStatus = async (member: TeamMembership, next: UserStatus) => {
    setSaving(true); configureApi(token, organisationId);
    try { await api.setTeamMember(team.id, { userId: member.userId, role: member.role, status: next }); onToast("Team membership updated."); await onChanged(); }
    catch (error) { const e = error instanceof ApiError ? error : null; onToast(e?.message ?? "Membership could not be updated.", "error", e?.requestId); }
    finally { setSaving(false); }
  };
  return <div className="drawer-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Team details"><div className="drawer-head"><div><span className="eyebrow">TEAM DETAILS</span><h2>Team settings</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div><div className="drawer-section"><div className="team-detail-title"><span className="team-detail-icon"><UsersRound size={20} /></span><div><h3>{team.name}</h3><code>{team.id}</code></div></div><Field label="Team name"><input value={name} onChange={event => setName(event.target.value)} disabled={!canManage} /></Field><Field label="Department"><select value={departmentId} onChange={event => setDepartmentId(event.target.value)} disabled={!canManage}><option value="">No department</option>{departments.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>{canManage && <button className="button button-secondary full-button" onClick={() => void saveTeam()} disabled={saving}><Check size={15} /> Save team settings</button>}</div><div className="drawer-section"><div className="drawer-section-heading"><div><div className="detail-label">Team members</div><p>{members.length} active member{members.length === 1 ? "" : "s"}</p></div></div>{members.length ? members.map(member => <div className="member-row" key={member.id}><span className="person-avatar">{users.find(user => user.id === member.userId)?.displayName.slice(0, 1).toUpperCase() ?? "U"}</span><span className="member-row-copy"><strong>{users.find(user => user.id === member.userId)?.displayName ?? member.userId}</strong><small>{roleLabels[member.role]}</small></span>{canManage ? <select className="member-status-select" value={member.status} onChange={event => void setMemberStatus(member, event.target.value as UserStatus)} disabled={saving}><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select> : <StatusBadge status={member.status} />}</div>) : <EmptyState title="No active members" description="Add an active organisation user to this team." compact />}{canManage && <div className="add-member-form"><label className="field-label" htmlFor="team-user">Add organisation member</label><select id="team-user" value={assignUser} onChange={event => setAssignUser(event.target.value)}><option value="">Choose a user</option>{eligibleUsers.map(user => <option value={user.id} key={user.id}>{user.displayName} · {user.email}</option>)}</select><div className="add-member-row"><select aria-label="Team role" value={memberRole} onChange={event => setMemberRole(event.target.value as TeamMembership["role"])}><option value="support_agent">Support agent</option><option value="support_lead">Support lead</option><option value="requester">Requester</option></select><button className="button button-primary button-small" disabled={!assignUser || saving} onClick={() => void addMember()}><Plus size={14} /> Add</button></div><small className="field-hint">The selected user must already have an active organisation membership.</small></div>}</div><div className="drawer-footer"><button className="button button-secondary" onClick={onClose}>Close</button></div></aside></div>;
}

function DataTable<T>({ columns, data, emptyTitle, emptyText }: { columns: ColumnDef<T, unknown>[]; data: T[]; emptyTitle: string; emptyText: string }) {
  const [globalFilter, setGlobalFilter] = useState("");
  const table = useReactTable({ data, columns, state: { globalFilter }, onGlobalFilterChange: setGlobalFilter, getCoreRowModel: getCoreRowModel(), getFilteredRowModel: getFilteredRowModel(), getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel(), initialState: { pagination: { pageSize: 8 } } });
  if (!data.length) return <EmptyState title={emptyTitle} description={emptyText} />;
  return <><div className="table-scroll"><table className="data-table"><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id}>{header.isPlaceholder ? null : <button className={`th-button ${header.column.getCanSort() ? "sortable" : ""}`} onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getCanSort() && (header.column.getIsSorted() === "asc" ? <ArrowUp size={13} /> : header.column.getIsSorted() === "desc" ? <ArrowDown size={13} /> : <ArrowUpDown size={13} />)}</button>}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div><div className="table-pagination"><span>Showing <strong>{table.getRowModel().rows.length}</strong> of <strong>{data.length}</strong></span><div><button className="icon-button" aria-label="Previous page" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}><ChevronLeft size={16} /></button><span>Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}</span><button className="icon-button" aria-label="Next page" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}><ChevronRight size={16} /></button></div></div></>;
}

function StatusBadge({ status }: { status: string }) { return <span className={`status-badge ${statusTone[status] ?? "status-muted"}`}><span />{status.replaceAll("_", " ")}</span>; }
function EmptyState({ title, description, compact = false }: { title: string; description: string; compact?: boolean }) { return <div className={`empty-state ${compact ? "empty-compact" : ""}`}><div className="empty-icon"><FileKey2 size={19} /></div><strong>{title}</strong><p>{description}</p></div>; }
function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) { return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</section></div>; }
function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) { return <label className="field"><span className="field-label">{label}{hint && <small>{hint}</small>}</span>{children}{error && <span className="field-error">{error}</span>}</label>; }
function FormFooter({ busy, onCancel, submit }: { busy: boolean; onCancel: () => void; submit: string }) { return <div className="form-footer"><button type="button" className="button button-secondary" onClick={onCancel}>Cancel</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy ? "Saving…" : submit}</button></div>; }
